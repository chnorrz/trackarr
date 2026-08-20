import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Camoufox } from 'camoufox-js';
import type { Browser, BrowserContext, Cookie, Page } from 'playwright-core';
import { TTLCache } from './cache.js';
import { isBlocked, isChallenge, solveChallenge } from './challenge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR is configurable so it can point at a mounted volume in Docker -
// otherwise cookies are lost on every container restart, forcing a cold
// Cloudflare clearance with no manual-solve fallback available.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const COOKIE_FILE = path.join(DATA_DIR, '.cf-cookies.json');
// A cf_clearance cookie is bound to the exact User-Agent it was issued to.
// solve.js records the UA it solved with; we must reuse it verbatim or the
// cookie is rejected. Camoufox otherwise randomises the spoofed OS (and so
// the UA) on every launch.
const UA_FILE = path.join(DATA_DIR, '.cf-ua.txt');

function loadCookies(): Cookie[] | null {
  try {
    return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveCookies(cookies: Cookie[]): void {
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
}

function loadUserAgent(): string | null {
  try {
    return fs.readFileSync(UA_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

let sharedBrowser: Browser | null = null;
let sharedContext: BrowserContext | null = null;

// In-flight launch promise, so concurrent first calls (e.g. the 4 parallel
// fetchCfProtectedPage() calls from a multi-category browse) await the same
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

// Optional upstream proxy for domains unreachable directly. Deliberately
// opt-in (DOMAIN_OVER_PROXY unset/empty = none) so a new domain never
// silently starts routing through a proxy an operator hasn't configured
// for it. See NOTES.md section 4 for the full story.
//
//   PROXY_URL         e.g. http://tinyproxy:8888. Unset = disabled entirely.
//   DOMAIN_OVER_PROXY comma-separated hostnames routed through it (exact
//                     match or subdomain).
//
// Routing is per-request via a PAC script (buildPacDataUri below), not a
// per-provider flag - a single page load can need both proxied and direct
// requests at once (see NOTES.md section 4).
const PROXY_URL = process.env.PROXY_URL || null;
const DOMAIN_OVER_PROXY = (process.env.DOMAIN_OVER_PROXY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function domainUsesProxy(hostname: string): boolean {
  if (!PROXY_URL || DOMAIN_OVER_PROXY.length === 0) return false;
  return DOMAIN_OVER_PROXY.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

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
  const browser = os
    ? await Camoufox({ headless, os, ...(firefoxPrefs ? { firefox_user_prefs: firefoxPrefs } : {}) })
    : await Camoufox({ headless, ...(firefoxPrefs ? { firefox_user_prefs: firefoxPrefs } : {}) });
  sharedBrowser = browser;

  const userAgent = loadUserAgent();
  if (userAgent) console.error(`[cf] using stored User-Agent: ${userAgent}`);
  const context = await browser.newContext(userAgent ? { userAgent } : {});
  sharedContext = context;

  const cookies = loadCookies();
  if (cookies) await context.addCookies(cookies).catch(() => {});
  return context;
}

// fetchCfProtectedPage()'s options - a standard RequestInit (method/headers/
// body/etc, same as the global fetch()) so the function is otherwise a
// drop-in replacement for fetch() minus getting a live Response back (this
// always resolves the body text directly instead - see
// fetchCfProtectedPage's own doc comment for why). No `proxy` field -
// routing is decided per-hostname by the PAC script (see DOMAIN_OVER_PROXY
// above), not per-call.
export type FetchOptions = RequestInit;

// One already-cleared, long-lived page per hostname, reused across many
// requests instead of opening/closing a fresh page per call - keyed by
// hostname since every current provider only ever talks to one.
//
// All hostnames share one browser/context - proxy routing is the PAC
// script's per-request decision (see DOMAIN_OVER_PROXY above), not a
// separate context to pick between. usingProxy is tracked per page only so
// fetchCfProtectedPage knows whether to persist cookies for it: a
// proxy-obtained cf_clearance is bound to the proxy's egress IP and
// shouldn't mix into the same file a direct-egress domain relies on.
const persistentPages = new Map<string, { page: Page; usingProxy: boolean }>();

// In-flight page-creation promise per hostname, so two concurrent first
// callers for the same new hostname (e.g. a real request racing the
// keepalive tick - observed live) await the same newPage() instead of each
// creating their own tab, with only one ever making it into
// persistentPages and the other silently leaked (never closed, never
// referenced again). Mirrors getPersistentContext()'s own
// persistentContextPromise fix for the same race one level up (browser/
// context instead of page).
const persistentPagePromises = new Map<string, Promise<{ page: Page; usingProxy: boolean }>>();

async function getOrCreatePersistentPage(hostname: string): Promise<{ page: Page; usingProxy: boolean }> {
  const existing = persistentPages.get(hostname);
  if (existing && !existing.page.isClosed()) return existing;

  let promise = persistentPagePromises.get(hostname);
  if (!promise) {
    promise = (async () => {
      const context = await getPersistentContext();
      const page = await context.newPage();
      const entry = { page, usingProxy: domainUsesProxy(hostname) };
      persistentPages.set(hostname, entry);
      return entry;
    })().catch((err) => {
      persistentPagePromises.delete(hostname);
      throw err;
    });
    persistentPagePromises.set(hostname, promise);
  }
  return promise;
}

// Tries to fetch `url` through an already-cleared persistent page's own
// live session (same-origin fetch() carries its cookies, and runs through
// the real browser's network stack - same reasoning as the magnet-POST/
// wlinks-POST flows that already did this). Returns null (never throws) on
// any failure - the caller falls back to a real navigation instead of
// treating a fetch error as fatal.
async function tryFetch(page: Page, url: string, init: RequestInit): Promise<string | null> {
  if (page.isClosed()) return null;
  try {
    return await page.evaluate<string, { url: string; init: RequestInit }>(async ({ url, init }) => {
      const res = await fetch(url, init);
      return await res.text();
    }, { url, init });
  } catch {
    return null;
  }
}

// Cache for fetchCfProtectedPage()'s results, keyed by a hash of
// method+url+body (not just the URL - a POST's response depends on its
// body too, e.g. ext.to's magnet POST reuses one URL for every torrent).
// See NOTES.md section 10 for why this replaced a top-level result cache.
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000;
const pageCache = new TTLCache<string>(CACHE_TTL_MS);

// A GET navigates straight to `url`. Anything else (a POST to an AJAX
// endpoint isn't a page you can navigate to) reuses wherever the page
// already is, falling back to the origin root if it has no real history yet
// (about:blank).
function pickNavigateTarget(url: string, currentUrl: string, isGet: boolean): string {
  if (isGet) return url;
  if (currentUrl && currentUrl !== 'about:blank') return currentUrl;
  return new URL(url).origin + '/';
}

// General-purpose Cloudflare-aware fetch, cached. Fast path: fetch() through
// the hostname's already-cleared persistent page - skips a full navigation
// when the session's still good. Slow path (challenged/blocked/failed):
// navigate that same page to re-solve the session (GET: straight to `url`;
// non-GET: wherever the page already is, since a POST endpoint isn't
// something you can navigate to), then retry the fetch. Self-heals inline
// per-request rather than waiting for the periodic keep-alive tick - see
// NOTES.md section 10 for the full reasoning and the cache-key subtlety.
export async function fetchCfProtectedPage(url: string, opts: FetchOptions = {}): Promise<string> {
  const { method = 'GET', headers, body } = opts;
  const init: RequestInit = { method, headers, body };
  const isGet = method.toUpperCase() === 'GET';
  const cacheKey = crypto.createHash('sha256').update(`${method}:${url}:${body ?? ''}`).digest('hex');

  const cached = pageCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const { page, usingProxy } = await getOrCreatePersistentPage(new URL(url).hostname);
  const navigateTarget = pickNavigateTarget(url, page.url(), isGet);

  // A brand-new page starts at about:blank, where fetch()'s same-origin
  // credential/CORS rules mean tryFetch() below is guaranteed to fail no
  // matter how valid the domain's cookies already are - not a real signal
  // that a challenge is present, just this check being unable to run yet.
  // A cheap domcontentloaded navigation gets the page onto the real origin
  // first, so tryFetch has an actual chance to succeed. On every call after
  // that first one, the page is already on the right origin and this is a
  // no-op.
  if (page.url() === 'about:blank') {
    await serializeNav(() => page.goto(navigateTarget, { waitUntil: 'domcontentloaded', timeout: 60000 })).catch(() => {});
  }

  const fast = await tryFetch(page, url, init);
  if (fast !== null && !isChallenge(fast) && !isBlocked(fast)) {
    pageCache.set(cacheKey, fast);
    return fast;
  }

  console.error(`[cf] fetchCfProtectedPage: fast path unavailable for ${url}, recovering session.`);
  await serializeSolve(() => solveChallenge(page, navigateTarget));
  if (!usingProxy) saveCookies(await page.context().cookies());

  const retried = await tryFetch(page, url, init);
  if (retried === null || isChallenge(retried) || isBlocked(retried)) {
    throw new Error(`fetchCfProtectedPage: fetch failed for ${url} even after session recovery.`);
  }
  pageCache.set(cacheKey, retried);
  return retried;
}

export async function closeBrowser(): Promise<void> {
  persistentPages.clear();
  persistentPagePromises.clear();
  if (sharedBrowser) await sharedBrowser.close();
  sharedBrowser = null;
  sharedContext = null;
}
