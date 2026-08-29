import crypto from 'node:crypto';
import { Camoufox } from 'camoufox-js';
import type { Browser, BrowserContext, Download, Page, Response as PlaywrightResponse } from 'playwright-core';
import { TTLCache } from './cache.js';
import { isBlocked, solveChallenge } from './challenge.js';
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

// serializeNav/serializeSolve each guard only one step; two cfFetch() calls
// for the same hostname would otherwise race on the same page. This wraps a
// whole recovery attempt per hostname instead, so a second call waits.
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

  // Logged so the effective prefs used for a memory-optimization pass are a
  // fact, not an assumption - see /status.json for what they cost in RAM.
  console.error(`[camoufox] effective firefox_user_prefs: ${JSON.stringify(firefoxPrefs ?? {})}`);

  // Keep the argument as one object literal: Camoufox()'s return type is
  // generic on user_data_dir, and hoisting it to a variable loses that.
  const browser = await Camoufox({ headless, os, window: WINDOW_SIZE, firefox_user_prefs: firefoxPrefs });

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

function recyclePage(hostname: string, page: Page): void {
  if (persistentPages.get(hostname) === page) persistentPages.delete(hostname);
  void page.close().catch(() => {});
}

// Body always read as base64 via res.blob() + FileReader.readAsDataURL(),
// not res.arrayBuffer(): Firefox's Xray wrappers (the boundary
// page.evaluate()'s injected code runs under) forbid reading TypedArray
// elements across it - a real error hit live, Camoufox is Firefox-based.
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
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);

      // A same-origin .torrent reads fine through plain fetch() - CORS only
      // restricts cross-origin bodies. Filename parsed from the response
      // header the same way suggestedFilename() derives it from a Download.
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

function isChallenge(response: TryFetchResponse | PlaywrightResponse | null): response is { challenged: true } | PlaywrightResponse {
  if (response === null) return false;
  if ('challenged' in response) return response.challenged;
  return response.headers()['cf-mitigated'] === 'challenge';
}

// `Cookie` is a forbidden header name per the Fetch spec, silently dropped
// by every browser rather than erroring. Uses Playwright's own cookie jar
// instead, which also covers page.goto()'s slow path (no opts.headers there).
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

// page.goto() throws "Download is starting" exactly when Firefox fires the
// 'download' event - one nav lands on a page or resolves as a Download.
// allowDownload=false warms the bare origin instead (a POST warm-up must never look like a download).
async function navigateOrDownload(page: Page, url: string, allowDownload: boolean): Promise<NavResult> {
  // Armed before goto(): Firefox fires 'download' at essentially the same
  // instant as the nav's "Download is starting" error, so listening only in
  // the catch below would race it. Left to reject on its own timeout if unused.
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

// A browser download can't carry arbitrary request headers the way fetch()
// can - Cookie goes through the context's cookie jar (applyCookieHeader)
// regardless of path; anything else silently vanishes on the download path.
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
  const remainingHeaders = headers ? Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== 'cookie')) : undefined;
  const init: FetchOptions = { method, headers: remainingHeaders, body };
  const cacheKey = crypto.createHash('sha256').update(`${method}:${url}:${body ?? ''}`).digest('hex');

  const cached = pageCache.get(cacheKey);
  if (cached !== undefined) return { base64: cached };

  const hostname = new URL(url).hostname;
  const page = await getOrCreatePersistentPage(hostname);
  await applyCookieHeader(page, hostname, headers);

  const allowDownload = method === 'GET' && !body;

  // A download's bytes ARE the response - nothing left to fetch, and (like
  // resolveMagnet's own choice for a Cardigann torrent) not worth caching.
  const navigate = async (allow: boolean): Promise<{ download: { base64: string; filename?: string } } | { response: PlaywrightResponse | null }> => {
    const nav = await serializeNav(() => navigateOrDownload(page, url, allow));
    if (nav.kind === 'download') {
      warnDroppedDownloadHeaders(url, headers);
      return { download: { base64: nav.base64, filename: nav.filename } };
    }
    return { response: nav.response };
  };

  // Exclusive per hostname: a second call for the same page must wait for
  // this one to finish, not interleave its own goto()/solveChallenge() with it.
  return serializeHost(hostname)(async () => {
    try {
      let firstNav = false;
      let response: PlaywrightResponse | null = null;

      if (page.url() === 'about:blank') {
        const nav = await navigate(allowDownload);
        firstNav = true;
        if ('download' in nav) return nav.download;
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
        const nav = await navigate(allowDownload);
        if ('download' in nav) return nav.download;
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

      // A challenge-gated file download can't be read by tryFetch's in-page
      // fetch() once cross-origin (no CORS headers). With clearance now
      // obtained, one more nav gives detection the chance it missed before.
      if ((retried === null || isChallenge(retried)) && allowDownload) {
        const nav = await navigate(true);
        if ('download' in nav) return nav.download;
      }

      if (retried === null || isChallenge(retried) || isBlocked(Buffer.from(retried.base64, 'base64').toString('utf-8'))) {
        throw new Error(`cfFetch: fetch failed for ${url} even after session recovery.`);
      }

      pageCache.set(cacheKey, retried.base64);
      return { base64: retried.base64, filename: retried.filename };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[cf] recycling page for ${url} after failure: ${message}`);
      recyclePage(hostname, page);
      throw err;
    }
  });
}

// Mirrors fetch()'s Response shape, but not its laziness: the body is
// already fully read and base64-encoded by the time this resolves, so
// text()/buffer() can each be called any number of times. filename is only
// set when the fetch actually had one (a Download or Content-Disposition).
export interface CfResponse {
  text(): Promise<string>;
  buffer(): Promise<Buffer>;
  filename?: string;
}

// Single entry point for everything cfFetch's callers need: a normal page's
// HTML/JSON, or a raw file's bytes (a .torrent, in practice), auto-detected
// rather than requiring the caller to know which in advance.
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
