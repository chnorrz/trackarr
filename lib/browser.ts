import crypto from 'crypto';
import { Camoufox } from 'camoufox-js';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { TTLCache } from './cache.js';
import { isBlocked, solveChallenge } from './challenge.js';
import { Response as PlaywrightResponse } from 'playwright-core';

// Clearances are deliberately NOT persisted across restarts - see NOTES.md
// section 5, "Why cf_clearance is not persisted".
//
// Camoufox otherwise randomises the window size per launch, which can come out
// larger than the Xvfb screen - live-observed at 2166x1447 on a 1280x900
// display, leaving part of the page rendered off-screen (so the solver's
// clicks land outside it) and reporting a window bigger than its own screen,
// an impossible geometry Camoufox itself lists as a detectable tell. Keep this
// within the Xvfb geometry in the Dockerfile's CMD.
const WINDOW_SIZE: [number, number] = [1280, 800];
const PROXY_URL = process.env.PROXY_URL || null;
const DOMAIN_OVER_PROXY = (process.env.DOMAIN_OVER_PROXY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let sharedBrowser: Browser | null = null;
let sharedContext: BrowserContext | null = null;

// In-flight launch promise, so concurrent first calls (e.g. the 4 parallel
// cfFetch() calls from a multi-category browse) await the same
// launch instead of each seeing sharedContext still null and racing to start
// their own browser. That race was observed live: multiple simultaneous
// "launching browser" attempts, several Camoufox/Firefox instances fighting
// over one Xvfb display, and a page.goto NS_ERROR_NET_TIMEOUT.
let persistentContextPromise: Promise<BrowserContext> | null = null;

// Runs tasks one at a time on a private queue. Two independent uses below:
// solves (XTEST input is global to the X display - two running at once
// fight over the same virtual mouse and both fail) and navigations
// (concurrent navigations to the same Cloudflare-protected host reliably
// hang until the 60s page.goto timeout, even though each succeeds fine
// alone - see NOTES.md section 6). Each gets its own queue via a separate
// call, so a slow solve doesn't block an unrelated navigation or vice versa.
function createSerializer() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => {},
      () => {}
    );
    return run;
  };
}
const serializeSolve = createSerializer();
const serializeNav = createSerializer();


// Builds a data: URI PAC (Proxy Auto-Config) script routing DOMAIN_OVER_PROXY
// through PROXY_URL, everything else direct - goes around Playwright's own
// `proxy` option (proxy-by-default + bypass only, can't express this shape)
// and drives Firefox's native network.proxy.* prefs instead (see
// launchPersistentContext, NOTES.md section 4). Null when unconfigured.
function buildPacDataUri(): string | null {
  if (!PROXY_URL || DOMAIN_OVER_PROXY.length === 0) return null;
  const proxyHost = new URL(PROXY_URL).host; // PAC wants "host:port", no scheme
  const pac = `function FindProxyForURL(url, host) {
  var domains = ${JSON.stringify(DOMAIN_OVER_PROXY)};
  for (var i = 0; i < domains.length; i++) {
    var d = domains[i];
    if (host === d || host.substring(host.length - d.length - 1) === '.' + d) {
      return "PROXY ${proxyHost}";
    }
  }
  return "DIRECT";
}`;
  return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString('base64')}`;
}

// Persistent browser/context, reused across requests so we don't pay
// browser-startup cost per request.
async function getPersistentContext(): Promise<BrowserContext> {
  if (sharedContext) return sharedContext;
  if (!persistentContextPromise) {
    persistentContextPromise = launchPersistentContext().catch((err) => {
      persistentContextPromise = null;
      throw err;
    });
  }
  return persistentContextPromise;
}

async function launchPersistentContext(): Promise<BrowserContext> {
  // On Linux we run a real (non-headless) browser against the Xvfb display
  // in DISPLAY. Camoufox's own 'virtual' mode would also use Xvfb, but at
  // 1x1 resolution, leaving no room to render/click the Turnstile widget.
  // On macOS (local dev) plain headless is fine.
  const headless = process.platform === 'linux' ? false : true;
  // Pin the spoofed OS so it stays consistent with the UA the stored
  // cf_clearance cookie was issued to (see UA_FILE above).
  const os = process.platform === 'linux' ? ('linux' as const) : undefined;

  // PAC-based routing (see buildPacDataUri above) instead of Playwright's
  // own `proxy` launch option - driven through raw Firefox prefs so
  // per-request routing decisions happen inside the browser itself, not at
  // the whole-context level Playwright's option is limited to.
  const pacDataUri = buildPacDataUri();
  if (pacDataUri) {
    console.error(`[cf] proxying [${DOMAIN_OVER_PROXY.join(', ')}] via ${PROXY_URL}, direct otherwise.`);
  }
  const firefoxPrefs = pacDataUri
    ? { 'network.proxy.type': 2, 'network.proxy.autoconfig_url': pacDataUri }
    : undefined;

  // A literal object argument at the call site (rather than a pre-built
  // `opts` variable) matters here: Camoufox()'s return type is generic on
  // whether user_data_dir is present, and extracting the parameter type
  // separately loses that inference, resolving to BrowserContext instead of
  // Browser. The conditional spreads stay inside this one literal for that
  // reason - it's still a single object expression at the call site.
  // No `disable_coop` and no `humanize` on purpose: both only matter for
  // Playwright's mouse API, and the solver injects input at the X server level
  // instead (see createPointer in lib/challenge.ts). COOP in particular would
  // be a tell Camoufox itself flags as WAF-detectable.
  const browser = os
    ? await Camoufox({ headless, os, window: WINDOW_SIZE, ...(firefoxPrefs ? { firefox_user_prefs: firefoxPrefs } : {}) })
    : await Camoufox({ headless, window: WINDOW_SIZE, ...(firefoxPrefs ? { firefox_user_prefs: firefoxPrefs } : {}) });
  sharedBrowser = browser;

  // No userAgent override and no restored cookies on purpose: Camoufox's
  // fingerprint is internally consistent, and overriding one field of it (or
  // replaying a clearance bound to a previous one) is worse than starting
  // clean. See NOTES.md section 5.
  const context = await browser.newContext();
  sharedContext = context;
  return context;
}

// cfFetch()'s options - a standard RequestInit (method/headers/
// body/etc, same as the global fetch()) so the function is otherwise a
// drop-in replacement for fetch() minus getting a live Response back (this
// always resolves the body text directly instead - see
// cfFetch's own doc comment for why). No `proxy` field -
// routing is decided per-hostname by the PAC script (see DOMAIN_OVER_PROXY
// above), not per-call.
export type FetchOptions = RequestInit;

// One already-cleared, long-lived page per hostname, reused across many
// requests instead of opening/closing a fresh page per call - keyed by
// hostname since every current provider only ever talks to one.
//
// All hostnames share one browser/context - proxy routing is the PAC
// script's per-request decision (see DOMAIN_OVER_PROXY above), not a
// separate context to pick between.
const persistentPages = new Map<string, Page>();

// In-flight page-creation promise per hostname, so two concurrent first
// callers for the same new hostname (e.g. a real request racing the
// keepalive tick - observed live) await the same newPage() instead of each
// creating their own tab, with only one ever making it into
// persistentPages and the other silently leaked (never closed, never
// referenced again). Mirrors getPersistentContext()'s own
// persistentContextPromise fix for the same race one level up (browser/
// context instead of page).
const persistentPagePromises = new Map<string, Promise<Page>>();

async function getOrCreatePersistentPage(hostname: string): Promise<Page> {
  const existing = persistentPages.get(hostname);
  if (existing && !existing.isClosed()) return existing;
  // Closed page: drop it so a crashed tab can't be handed out again.
  persistentPages.delete(hostname);

  let promise = persistentPagePromises.get(hostname);
  if (!promise) {
    promise = (async () => {
      const context = await getPersistentContext();
      const page = await context.newPage();
      persistentPages.set(hostname, page);
      return page;
    })()
      .catch((err) => {
        // newPage() only fails like this when the context/browser itself is
        // gone, and a dead context poisons every future call. Drop it so the
        // next caller relaunches instead of failing forever.
        sharedContext = null;
        persistentContextPromise = null;
        throw err;
      })
      // Must clear on success too, not just on error. This map exists only to
      // dedupe *in-flight* creation; leaving a resolved promise in it meant a
      // page that later crashed was served from here forever, since the
      // isClosed() check above skips persistentPages but this cache still
      // returned the same dead page. Live-caught: 1337x failed every keepalive
      // tick with "Target page, context or browser has been closed" and never
      // recovered.
      .finally(() => {
        persistentPagePromises.delete(hostname);
      });
    persistentPagePromises.set(hostname, promise);
  }
  return promise;
}

type TryFetchResponse = { challenged: false, content: string} | { challenged: true } | null;

// Tries to fetch `url` through an already-cleared persistent page's own
// live session (same-origin fetch() carries its cookies, and runs through
// the real browser's network stack - same reasoning as the magnet-POST/
// wlinks-POST flows that already did this). Returns null (never throws) on
// any failure - the caller falls back to a real navigation instead of
// treating a fetch error as fatal.
async function tryFetch(page: Page, url: string, init: RequestInit): Promise<TryFetchResponse> {
  if (page.isClosed()) return null;
  try {
    return await page.evaluate<TryFetchResponse, { url: string; init: RequestInit }>(async ({ url, init }) => {
      const res = await fetch(url, init);
      return res.headers.get('cf-mitigated') === 'challenge'
        ? { challenged: true }
        : { challenged: false, content: await res.text() };
    }, { url, init });
  } catch {
    return null;
  }
}

// Cache for cfFetch()'s results, keyed by a hash of
// method+url+body (not just the URL - a POST's response depends on its
// body too, e.g. ext.to's magnet POST reuses one URL for every torrent).
// See NOTES.md section 10 for why this replaced a top-level result cache.
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000;
const pageCache = new TTLCache<string>(CACHE_TTL_MS);

// Cloudflare marks a challenged response with `cf-mitigated: challenge`. Read
// off the header for a navigation response, and off the flag tryFetch already
// derived from it for a fetch, since the body of a challenged fetch is never
// carried back.
export function isChallenge(response: TryFetchResponse | PlaywrightResponse | null): response is { challenged: true } | PlaywrightResponse {
  if (response === null) return false;
  if ('challenged' in response) return response.challenged;
  return response.headers()['cf-mitigated'] === 'challenge';
}

// General-purpose Cloudflare-aware fetch, cached. Fast path: fetch() through
// the hostname's already-cleared persistent page - skips a full navigation
// when the session's still good. Slow path (challenged/blocked/failed):
// navigate that same page to re-solve the session (GET: straight to `url`;
// non-GET: wherever the page already is, since a POST endpoint isn't
// something you can navigate to), then retry the fetch. Self-heals inline
// per-request rather than waiting for the periodic keep-alive tick - see
// NOTES.md section 10 for the full reasoning and the cache-key subtlety.
export async function cfFetch(url: string, opts: FetchOptions = {}): Promise<string> {
  const { method = 'GET', headers, body } = opts;
  const init: RequestInit = { method, headers, body };
  const cacheKey = crypto.createHash('sha256').update(`${method}:${url}:${body ?? ''}`).digest('hex');

  const cached = pageCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const page = await getOrCreatePersistentPage(new URL(url).hostname);

  // A brand-new page starts at about:blank, where fetch()'s same-origin
  // credential/CORS rules mean tryFetch() below is guaranteed to fail no
  // matter how valid the domain's cookies already are - not a real signal
  // that a challenge is present, just this check being unable to run yet.
  // A cheap domcontentloaded navigation gets the page onto the real origin
  // first, so tryFetch has an actual chance to succeed. On every call after
  // that first one, the page is already on the right origin and this is a
  // no-op.
  let firstNav = false;
  let response: PlaywrightResponse | null = null;

  if (page.url() === 'about:blank') {
    response = await serializeNav(() => page.goto(url, { waitUntil: 'commit', timeout: 15000 }));
    firstNav = true;
  }

  if (!isChallenge(response)) {
    const fast = await tryFetch(page, url, init);
    if (fast !== null && !isChallenge(fast)) {
      if (isBlocked(fast.content)) {
        throw new Error(`cfFetch: fetch failed for ${url} even though the page shows no challenge - probably your IP got blocked.`);
      }
      pageCache.set(cacheKey, fast.content);
      return fast.content;
    }
  }

  console.error(`[cf] cfFetch: fast path unavailable for ${url}, recovering session.`);
  // Let any navigation the failed fetch kicked off settle before queueing for
  // the solve mutex, so we wait on our own time rather than holding the mutex
  // while the page loads. Errors ignored: there may be no navigation in
  // flight at all, which is not a problem.
  if (!firstNav) {
    response = await serializeNav(() => page.goto(url, { waitUntil: 'commit', timeout: 15000 }));
  }

  // Only solve when the recovery navigation actually came back challenged. A
  // clean response means the session already recovered - the navigation alone
  // was enough - so fall through to the retry below instead of erroring on a
  // page that is now perfectly usable. Live-caught after a container restart:
  // EZTV's fast path failed on a stale cookie, the recovery navigation
  // returned a clean 200, and this threw anyway.
  if (isChallenge(response)) {
    const clearance = await serializeSolve(async () => {
      await page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});

      try {
        return await solveChallenge(page);
      } catch (err: unknown) {
        console.error(`[cf] solveChallenge failed for ${url}: ${(err as Error).message}`);
        throw err;
      }
    });
    // Kept in the browser's own jar for the life of the process; never
    // written to disk (NOTES.md section 5).
    if (clearance) console.error(`[cf] cf_clearance obtained (${clearance.slice(0, 8)}...).`);
  }

  const retried = await tryFetch(page, url, init);
  if (retried === null || isChallenge(retried) || isBlocked(retried.content)) {
    throw new Error(`cfFetch: fetch failed for ${url} even after session recovery.`);
  }
  pageCache.set(cacheKey, retried.content);
  return retried.content;
}

export async function closeBrowser(): Promise<void> {
  persistentPages.clear();
  persistentPagePromises.clear();
  if (sharedBrowser) await sharedBrowser.close();
  sharedBrowser = null;
  sharedContext = null;
}
