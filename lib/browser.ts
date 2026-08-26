import crypto from 'crypto';
import { Camoufox } from 'camoufox-js';
import type { Browser, BrowserContext, Download, Page } from 'playwright-core';
import { TTLCache } from './cache.js';
import { isBlocked, solveChallenge } from './challenge.js';
import { Response as PlaywrightResponse } from 'playwright-core';
import type { ProviderCookie } from './types.js';

// Must stay within the Xvfb geometry in the Dockerfile's CMD: a window larger
// than the screen renders partly off-screen and is a detectable tell.
const WINDOW_SIZE: [number, number] = [1280, 800];
const PROXY_URL = process.env.PROXY_URL || null;
const DOMAIN_OVER_PROXY = (process.env.DOMAIN_OVER_PROXY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

type BrowserSession = { browser: Browser; context: BrowserContext };

let session: Promise<BrowserSession> | null = null;

// Providers register cookies once at startup; applied to every fresh context
// so a session discard/relaunch (e.g. after a browser crash) doesn't drop them.
let registeredCookies: ProviderCookie[] = [];

export function registerDomainCookies(cookies: ProviderCookie[]): void {
  registeredCookies = registeredCookies.concat(cookies);
}

// XTEST input is global to the X display, and concurrent navigations to one
// Cloudflare-protected host hang until the page.goto timeout.
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

// serializeNav/serializeSolve each only guard one step (one goto, one solve),
// not the operation as a whole. Two cfFetch() calls for the same hostname
// otherwise race on the same page - e.g. one is mid-solveChallenge() (only
// inside serializeSolve) while the other calls page.goto() on that same page
// (only inside serializeNav), interrupting the solve's own navigation. This
// wraps a whole recovery attempt per hostname so a second call for a page
// already in use waits for the first to finish, instead of touching it too.
const hostSerializers = new Map<string, ReturnType<typeof createSerializer>>();

function serializeHost(hostname: string) {
  let serialize = hostSerializers.get(hostname);
  if (!serialize) {
    serialize = createSerializer();
    hostSerializers.set(hostname, serialize);
  }
  return serialize;
}

// Routes only DOMAIN_OVER_PROXY through the proxy: Playwright's own `proxy`
// option is proxy-by-default plus bypass and cannot express that shape.
function buildPacDataUri(): string | null {
  if (!PROXY_URL || DOMAIN_OVER_PROXY.length === 0) return null;
  const proxyHost = new URL(PROXY_URL).host;
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

function getSession(): Promise<BrowserSession> {
  if (!session) {
    session = launchSession().catch((err) => {
      session = null;
      throw err;
    });
  }

  return session;
}

// Closing the browser is best-effort: it may already be gone, which is the
// usual reason we are discarding the session in the first place.
async function discardSession(): Promise<void> {
  const current = session;
  session = null;
  persistentPages.clear();
  persistentPagePromises.clear();

  const live = await current?.catch(() => null);
  try {
    await live?.browser.close();
  } catch { /* already gone */ }
}

async function launchSession(): Promise<BrowserSession> {
  // Camoufox's own 'virtual' mode also uses Xvfb but at 1x1, leaving no room to
  // render or click the Turnstile widget, so on Linux run against DISPLAY.
  const headless = process.platform === 'linux' ? false : true;
  const os = process.platform === 'linux' ? ('linux' as const) : undefined;

  const pacDataUri = buildPacDataUri();
  if (pacDataUri) {
    console.error(`[cf] proxying [${DOMAIN_OVER_PROXY.join(', ')}] via ${PROXY_URL}, direct otherwise.`);
  }
  const firefoxPrefs = pacDataUri
    ? { 'network.proxy.type': 2, 'network.proxy.autoconfig_url': pacDataUri }
    : undefined;

  // Keep the argument as one object literal: Camoufox()'s return type is
  // generic on user_data_dir, and hoisting it to a variable loses that.
  const browser = os
    ? await Camoufox({ headless, os, window: WINDOW_SIZE, ...(firefoxPrefs ? { firefox_user_prefs: firefoxPrefs } : {}) })
    : await Camoufox({ headless, window: WINDOW_SIZE, ...(firefoxPrefs ? { firefox_user_prefs: firefoxPrefs } : {}) });

  const context = await browser.newContext();
  if (registeredCookies.length) {
    await context.addCookies(registeredCookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path ?? '/' })));
  }

  return { browser, context };
}

// Narrower than RequestInit on purpose: these values are serialized into
// page.evaluate(), so a stream/Blob/FormData body would silently arrive as {}.
export type FetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

const persistentPages = new Map<string, Page>();
const persistentPagePromises = new Map<string, Promise<Page>>();

async function getOrCreatePersistentPage(hostname: string): Promise<Page> {
  const existing = persistentPages.get(hostname);

  if (existing && !existing.isClosed()) {
    return existing;
  }

  persistentPages.delete(hostname);

  // Nothing may await between this lookup and the set below, or two
  // concurrent callers would each open a page for one hostname.
  let pending = persistentPagePromises.get(hostname);

  if (!pending) {
    pending = openPersistentPage(hostname);
    persistentPagePromises.set(hostname, pending);
  }

  return pending;
}

async function openPersistentPage(hostname: string): Promise<Page> {
  try {
    const { context } = await getSession();
    const page = await context.newPage();
    persistentPages.set(hostname, page);
    return page;
  } catch (err) {
    await discardSession();
    throw err;
  } finally {
    persistentPagePromises.delete(hostname);
  }
}

function recyclePage(page: Page): void {
  for (const [hostname, tracked] of persistentPages) {
    if (tracked === page) {
      persistentPages.delete(hostname);
      break;
    }
  }

  void page.close().catch(() => {});
}

// Always reads the body as bytes, base64-encoded to cross the browser/Node
// boundary as a plain string - one fetch path for everything, text
// included: res.text() would work for HTML/JSON, but would also be a
// second code path that could silently drift from this one, for a response
// small enough (a torrent file is a few KB) that base64's overhead is free
// either way. cfFetch's own CfResponse decodes this however the caller
// needs it, below.
//
// The encoding goes through res.blob() + FileReader.readAsDataURL(), not
// res.arrayBuffer() + manual byte indexing: Firefox's Xray wrappers (the
// security boundary page.evaluate()'s injected code runs under, relative to
// the page's own realm) forbid directly reading TypedArray elements across
// that boundary ("Accessing TypedArray data over Xrays is slow, and
// forbidden" - a real error hit live, Camoufox is Firefox-based). A Blob
// has no such element-level access, and FileReader's own base64 encoding
// happens in the browser's native code, not user-visible TypedArray reads,
// so it isn't subject to the restriction.
type TryFetchResponse = { challenged: false; base64: string; filename?: string } | { challenged: true } | null;

async function tryFetch(page: Page, url: string, init: FetchOptions): Promise<TryFetchResponse> {
  if (page.isClosed()) return null;
  try {
    return await page.evaluate<TryFetchResponse, { url: string; init: FetchOptions }>(async ({ url, init }) => {
      const res = await fetch(url, init);
      if (res.headers.get('cf-mitigated') === 'challenge') return { challenged: true };

      const blob = await res.blob();
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      // "data:<mime>;base64,<payload>" - only the payload is wanted; a
      // response with an empty body still yields a valid "data:...;base64,"
      // prefix with nothing after the comma, so this doesn't need a
      // separate empty-body special case.
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);

      // A same-origin .torrent (unlike itorrents.org's cross-origin one,
      // which never reaches this path at all - see navigateOrDownload)
      // reads fine through plain fetch(): CORS only restricts cross-origin
      // bodies, and fetch() never triggers page.goto()'s download
      // interception. Its real filename still lives in the response
      // header rather than anywhere fetch() surfaces automatically, so
      // it's parsed out here the same way suggestedFilename() would derive
      // it from a real Download object.
      const cd = res.headers.get('content-disposition') || '';
      const match = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
      const filename = match?.[1] ? decodeURIComponent(match[1].replace(/"/g, '')) : undefined;

      return { challenged: false, base64, filename };
    }, { url, init });
  } catch {
    return null;
  }
}

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000;
const pageCache = new TTLCache<string>(CACHE_TTL_MS);

export function isChallenge(response: TryFetchResponse | PlaywrightResponse | null): response is { challenged: true } | PlaywrightResponse {
  if (response === null) return false;
  if ('challenged' in response) return response.challenged;
  return response.headers()['cf-mitigated'] === 'challenge';
}

// A `Cookie` header can't be set from page-context JS: it's a forbidden
// header name per the Fetch spec, silently dropped by every browser
// (Chrome, Firefox/Camoufox included) rather than erroring, which makes it
// look like it worked. A Cardigann definition's search.headers.cookie
// (e.g. eztv.yml's layout=def_wlinks) needs Playwright's own cookie jar
// instead - which has the added benefit of applying to every request from
// this context, not just the one page.evaluate(fetch()) call: a full
// page.goto() navigation (the "slow path" below, after a challenge) never
// carries opts.headers at all, but does send whatever's in the cookie jar.
async function applyCookieHeader(page: Page, hostname: string, headers: Record<string, string> | undefined): Promise<void> {
  if (!headers) return;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie');
  if (!key || !headers[key]) return;

  const cookies = headers[key]
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = eq === -1 ? pair : pair.slice(0, eq);
      const value = eq === -1 ? '' : pair.slice(eq + 1);
      return { name, value, domain: hostname, path: '/' };
    });

  if (cookies.length) await page.context().addCookies(cookies);
}

const NAV_TIMEOUT_MS = 15000;

type NavResult = { kind: 'page'; response: PlaywrightResponse | null } | { kind: 'download'; base64: string; filename: string };

// One navigation primitive doing double duty as detection: page.goto()
// throws "Download is starting" for a direct file response (confirmed live
// against itorrents.org) exactly when Firefox fires the page's 'download'
// event (verified by reading playwright-core's own source:
// _onDownloadCreated calls frameAbortedNavigation with that same message
// right where it dispatches the event) - so the same one navigation either
// lands on a normal page, or resolves as a real Download, with no separate
// probe request needed and no second fetch mechanism to keep in sync.
// download.createReadStream()'s bytes ARE the response; there's nothing
// left to fetch afterwards.
//
// allowDownload gates whether "Download is starting" is treated as a real
// download or falls back to warming the bare origin (this function's own
// prior behavior, kept for that case): a POST's own warm-up navigation
// must never be treated as a download, since silently returning a
// downloaded file's bytes instead of performing the POST would be a real
// (and non-obvious) bug. See fetchViaSession's allowDownload.
//
// A challenge (or the block-ban page) is frequently scoped to the specific
// path being requested, not the whole origin (confirmed live: eztvx.to's
// bare "/" navigates cleanly while its own "/search/..." independently
// shows Cloudflare's challenge) - navigating to the bare origin instead of
// url would miss detecting/solving a challenge scoped that way, so the
// fallback (when a download isn't allowed here) still tries the exact url
// first.
//
// Confirmed live (not assumed): a download-triggering goto() leaves the
// page's url, JS context and cookies completely untouched - safe to run on
// the persistent per-hostname page, no separate scratch page needed.
async function navigateOrDownload(page: Page, url: string, allowDownload: boolean): Promise<NavResult> {
  // Armed before goto(), matching Playwright's own documented pattern -
  // Firefox fires the 'download' event at essentially the same instant as
  // the nav's own "Download is starting" error, so listening only inside
  // the catch below would race it. A goto() that turns out NOT to be a
  // download leaves this waiter armed and unused; it's not manually
  // cancelable, so it's left to reject on its own timeout - swallowed here
  // so that never surfaces as an unhandled rejection. In practice this only
  // ever happens on the (relatively rare) first-nav/session-recovery path,
  // not per request, so the brief dangling listener is an acceptable trade
  // against the alternative of a second, reactive-only detection mechanism
  // that could miss the real event.
  const downloadPromise = allowDownload ? page.waitForEvent('download', { timeout: NAV_TIMEOUT_MS }) : null;
  downloadPromise?.catch(() => {});

  try {
    const response = await page.goto(url, { waitUntil: 'commit', timeout: NAV_TIMEOUT_MS });
    return { kind: 'page', response };
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('Download is starting')) throw err;

    if (!downloadPromise) {
      const response = await page.goto(`${new URL(url).origin}/`, { waitUntil: 'commit', timeout: NAV_TIMEOUT_MS });
      return { kind: 'page', response };
    }

    const download: Download = await downloadPromise;
    const failure = await download.failure();
    if (failure) throw new Error(`cfFetch: download failed for ${url}: ${failure}`, { cause: err });

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const filename = download.suggestedFilename();
    await download.delete().catch(() => {});

    return { kind: 'download', base64: Buffer.concat(chunks).toString('base64'), filename };
  }
}

// The one fetch path (see tryFetch), returning the response body as base64
// for cfFetch's CfResponse to decode however its caller needs.
// isBlocked() (a substring pattern match for the ban page's own text)
// runs against the UTF-8 decoding of whatever came back - harmless even for
// genuinely binary content (a torrent file coincidentally containing both
// "Access denied" and "Cloudflare" as literal substrings is not a real risk)
// and means there's no separate binary-mode branch to keep in sync.
// A browser download can't carry arbitrary request headers the way fetch()
// can - Cookie is routed through the context's own cookie jar
// (applyCookieHeader) regardless of which path a fetch takes; anything
// else would silently vanish on the download path specifically (tryFetch's
// own in-page fetch() carries every header just fine), so it's called out
// instead. Nothing in the definitions vendored so far ever reaches this
// (only ext-to.yml sets download.headers, and it always resolves to a
// magnet), but a future one might.
function warnDroppedDownloadHeaders(url: string, headers: Record<string, string> | undefined): void {
  for (const key of Object.keys(headers ?? {})) {
    if (key.toLowerCase() !== 'cookie') {
      console.error(`[cf] cfFetch: header "${key}" can't be sent by a browser download, ignored for ${url}.`);
    }
  }
}

async function fetchViaSession(url: string, opts: FetchOptions): Promise<{ base64: string; filename?: string }> {
  const { method = 'GET', headers, body } = opts;
  // Cookie is stripped here (see applyCookieHeader) rather than left for
  // fetch() to silently ignore - one clear mechanism, not two that could
  // disagree.
  const remainingHeaders = headers ? Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'cookie')) : headers;
  const init: FetchOptions = { method, headers: remainingHeaders, body };
  const cacheKey = crypto.createHash('sha256').update(`${method}:${url}:${body ?? ''}`).digest('hex');

  const cached = pageCache.get(cacheKey);
  if (cached !== undefined) return { base64: cached };

  const hostname = new URL(url).hostname;
  const page = await getOrCreatePersistentPage(hostname);
  await applyCookieHeader(page, hostname, headers);

  // A GET with no body is the only shape safe to treat as a possible
  // download - a POST's own warm-up navigation (below) must never be, or a
  // download response landing on that url would silently return a
  // downloaded file's bytes instead of ever performing the POST.
  const allowDownload = method === 'GET' && !body;

  // Exclusive per hostname: a second call for the same page must wait for
  // this one to finish, not interleave its own goto()/solveChallenge() with it.
  return serializeHost(hostname)(async () => {
    try {
      let firstNav = false;
      let response: PlaywrightResponse | null = null;

      if (page.url() === 'about:blank') {
        const nav = await serializeNav(() => navigateOrDownload(page, url, allowDownload));
        firstNav = true;
        // A real download's bytes ARE the response - nothing left to fetch,
        // and (matching resolveMagnet's own choice for a Cardigann torrent
        // result) not worth caching for what's normally a one-shot grab.
        if (nav.kind === 'download') {
          warnDroppedDownloadHeaders(url, headers);
          return { base64: nav.base64, filename: nav.filename };
        }
        response = nav.response;
      }

      if (!isChallenge(response)) {
        const fast = await tryFetch(page, url, init);
        if (fast !== null && !isChallenge(fast)) {
          if (isBlocked(Buffer.from(fast.base64, 'base64').toString('utf-8'))) {
            throw new Error(`cfFetch: fetch failed for ${url} even though the page shows no challenge - probably your IP got blocked.`);
          }
          pageCache.set(cacheKey, fast.base64);
          return { base64: fast.base64, filename: fast.filename };
        }
      }

      console.error(`[cf] cfFetch: fast path unavailable for ${url}, recovering session.`);
      if (!firstNav) {
        const nav = await serializeNav(() => navigateOrDownload(page, url, allowDownload));
        if (nav.kind === 'download') {
          warnDroppedDownloadHeaders(url, headers);
          return { base64: nav.base64, filename: nav.filename };
        }
        response = nav.response;
      }

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

        if (clearance) console.error(`[cf] cf_clearance obtained (${clearance.slice(0, 8)}...).`);
      }

      const retried = await tryFetch(page, url, init);

      if (retried === null || isChallenge(retried) || isBlocked(Buffer.from(retried.base64, 'base64').toString('utf-8'))) {
        throw new Error(`cfFetch: fetch failed for ${url} even after session recovery.`);
      }

      pageCache.set(cacheKey, retried.base64);
      return { base64: retried.base64, filename: retried.filename };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cf] recycling page for ${url} after failure: ${message}`);
      recyclePage(page);
      throw err;
    }
  });
}

// Mirrors fetch()'s own Response shape (text()/arrayBuffer()-like) for
// familiarity, but not its laziness or single-read restriction: by the time
// fetchViaSession() resolves, the whole body has already been read and
// base64-encoded inside the page context (page.evaluate() is one
// round-trip, not a stream), so there's no download left to defer and no
// real "body already consumed" hazard - text() and buffer() can each be
// called any number of times, decoding the same already-in-memory base64.
//
// filename is only ever populated on the path that actually has one to
// give: a real Download's suggestedFilename(), or tryFetch()'s own
// Content-Disposition parse for a same-origin file fetched in-page. A
// plain HTML/JSON response has neither and leaves it undefined - callers
// that only ever want text (every hand-written provider, most of
// Cardigann) never look at it.
export interface CfResponse {
  text(): Promise<string>;
  buffer(): Promise<Buffer>;
  filename?: string;
}

// A single entry point for everything cfFetch's callers need: a normal
// page's HTML/JSON, or a raw file's bytes (a .torrent, in practice - see
// download.ts), auto-detected rather than requiring the caller to know
// which in advance - fetchViaSession()/navigateOrDownload() do the actual
// detection (one navigation doing double duty, see there for the full
// rationale and the live evidence behind it).
export async function cfFetch(url: string, opts: FetchOptions = {}): Promise<CfResponse> {
  const { base64, filename } = await fetchViaSession(url, opts);
  return {
    text: async () => Buffer.from(base64, 'base64').toString('utf-8'),
    buffer: async () => Buffer.from(base64, 'base64'),
    filename
  };
}

export async function closeBrowser(): Promise<void> {
  await discardSession();
}
