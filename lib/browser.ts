import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Camoufox } from 'camoufox-js';
import type { Browser, BrowserContext, Cookie, Page } from 'playwright-core';
import { TTLCache } from './cache.js';

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

function isChallenge(html: string): boolean {
  // Note: 'challenge-platform' is NOT a reliable marker - Cloudflare injects a
  // bot-management beacon script (/cdn-cgi/challenge-platform/scripts/jsd/main.js)
  // on legit, already-cleared pages too, causing false positives.
  return html.includes('cf-turnstile') || html.includes('Just a moment');
}

// A hard Cloudflare deny (IP ban/rate limit, error 1006/1015/etc.) is a
// static error page - no Turnstile widget, so isChallenge() doesn't catch
// it. Left undetected, this silently looks like a real "cleared" page with
// zero search results instead of a clear failure.
function isBlocked(html: string): boolean {
  return html.includes('Access denied') && html.includes('Cloudflare');
}

async function safeContent(page: Page): Promise<string> {
  try {
    return await page.content();
  } catch {
    return '';
  }
}

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
let proxyBrowser: Browser | null = null;
let proxyContext: BrowserContext | null = null;

// In-flight launch promises, so concurrent first calls (e.g. the 4 parallel
// fetchCfProtectedPage() calls from a multi-category browse) await the same launch
// instead of each seeing sharedContext/proxyContext still null and racing to
// start their own browser. That race was observed live: 4 simultaneous
// "launching proxied browser" logs, 4 separate Camoufox/Firefox instances
// fighting over one Xvfb display, and a page.goto NS_ERROR_NET_TIMEOUT.
let persistentContextPromise: Promise<BrowserContext> | null = null;
let proxyContextPromise: Promise<BrowserContext | null> | null = null;

// XTEST input is global to the X display, so two solves running at once fight
// over the same virtual mouse and both fail. Matters most with the background
// keep-alive, which can otherwise collide with a search's solve.
//
// Deliberately minimal: only the solve is serialised. An earlier attempt also
// added a reload/bringToFront/viewport rework and broke solving outright.
let solveChain: Promise<unknown> = Promise.resolve();

function serializeSolve<T>(task: () => Promise<T>): Promise<T> {
  const run = solveChain.then(task, task);
  solveChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

// Concurrent navigations to the same browser context/egress IP get treated
// as suspicious by Cloudflare: multi-category browsing (fetchMergedBrowse,
// 1337x's no-cat snapshot) fires several fetchCfProtectedPage() slow-path
// navigations at once, and
// live-testing found that 2+ concurrent navigations to the same
// Cloudflare-protected host reliably hang until the 60s page.goto timeout,
// even though each one succeeds fine on its own. Queuing navigations one at
// a time per context (direct vs proxied - they're separate browsers/IPs, so
// they don't contend with each other) fixes it, at the cost of the rare
// multi-category blank-browse case taking roughly N times as long as a
// single-category one instead of running in parallel.
let directNavChain: Promise<unknown> = Promise.resolve();
let proxyNavChain: Promise<unknown> = Promise.resolve();

function serializeNav<T>(usingProxy: boolean, task: () => Promise<T>): Promise<T> {
  const chain = usingProxy ? proxyNavChain : directNavChain;
  const run = chain.then(task, task);
  const settled = run.then(
    () => {},
    () => {}
  );
  if (usingProxy) proxyNavChain = settled;
  else directNavChain = settled;
  return run;
}

// Optional upstream proxy, for providers that can't be reached directly
// (see NOTES.md - 1337x bans our IPv4, and the container has no IPv6).
//
//   PROXY_URL        e.g. http://host.docker.internal:8888. Unset = the
//                    proxy is disabled entirely and everything goes direct.
//   PROXY_PROVIDERS  comma-separated provider ids allowed to use it. Unset
//                    or empty = none - a provider asking for the proxy in
//                    code (fetchCfProtectedPage(url, {proxy: 'id'})) is not
//                    enough on its own, it must be explicitly allow-listed
//                    here too.
//                    This is deliberately opt-in rather than opt-out: adding
//                    a new provider that happens to ask for a proxy should
//                    never silently start routing traffic through one an
//                    operator hasn't reviewed/configured for it.
const PROXY_URL = process.env.PROXY_URL || null;
const PROXY_PROVIDERS = (process.env.PROXY_PROVIDERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function proxyEnabledFor(who: string | null): boolean {
  if (!PROXY_URL || !who) return false;
  return PROXY_PROVIDERS.includes(who);
}

// Solves a Cloudflare Turnstile challenge by driving the mouse at the X
// server level.
//
// Two non-obvious things are required, both verified empirically:
//
//  1. Input must be injected via XTEST (xdotool), not Playwright's mouse
//     API. With Playwright input the widget sits on "Verifying..." forever
//     and never offers a checkbox; with XTEST input it advances to a real
//     "Verify you are human" checkbox. XTEST events are indistinguishable
//     from hardware to Firefox, Playwright's are injected further up.
//
//  2. xdotool works in SCREEN coordinates while getBoundingClientRect()
//     returns PAGE coordinates. Firefox's window chrome offsets the content
//     area (mozInnerScreenY is ~57px), so clicking raw page coords lands
//     above the checkbox and does nothing.
async function autoSolveChallenge(page: Page): Promise<boolean> {
  const display = process.env.DISPLAY;
  if (!display) return false;

  const xdo = (args: string[]): boolean => {
    try {
      execFileSync('xdotool', args, { env: { ...process.env, DISPLAY: display } });
      return true;
    } catch {
      return false;
    }
  };

  if (!xdo(['getdisplaygeometry'])) {
    console.error('[cf] xdotool unavailable, cannot auto-solve.');
    return false;
  }

  console.error('[cf] auto-solving challenge (X-level input)...');

  // Movement warm-up: this is what gets the widget past "Verifying...".
  for (let i = 0; i < 30; i++) {
    xdo([
      'mousemove',
      String(300 + Math.round(Math.sin(i / 4) * 250) + i * 8),
      String(300 + Math.round(Math.cos(i / 5) * 160))
    ]);
    await new Promise((r) => setTimeout(r, 100));
  }

  interface WidgetGeo {
    offX: number;
    offY: number;
    rect: { x: number; y: number; h: number } | null;
  }

  // mozInnerScreenX/Y are Firefox-only, not in lib.dom.d.ts (which models a
  // more Chromium-shaped Window) - this callback runs inside Firefox itself
  // (see the module comment above on why page coords need this offset), so
  // they're genuinely present at runtime despite TS not knowing about them.
  interface FirefoxWindow extends Window {
    mozInnerScreenX: number;
    mozInnerScreenY: number;
  }

  const geo = await page
    .evaluate<WidgetGeo>(() => {
      const el = document.querySelector('[id^=cf-chl-widget], .cf-turnstile, #mZiFs3');
      const r = el ? el.getBoundingClientRect() : null;
      const win = window as unknown as FirefoxWindow;
      return {
        offX: win.mozInnerScreenX,
        offY: win.mozInnerScreenY,
        rect: r ? { x: r.x, y: r.y, h: r.height } : null
      };
    })
    .catch(() => null);

  if (!geo || !geo.rect) {
    console.error('[cf] no Turnstile widget found to click.');
    return false;
  }

  // Checkbox sits at the left edge of the widget, vertically centred.
  const cx = Math.round(geo.offX + geo.rect.x + 22);
  const cy = Math.round(geo.offY + geo.rect.y + geo.rect.h / 2);
  console.error(`[cf] clicking checkbox at screen ${cx},${cy}`);

  for (const [dx, dy, wait] of [
    [-150, -80, 350],
    [-60, -25, 300],
    [-12, -4, 250],
    [0, 0, 500]
  ] as const) {
    xdo(['mousemove', String(cx + dx), String(cy + dy)]);
    await new Promise((r) => setTimeout(r, wait));
  }
  xdo(['click', '1']);
  return true;
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
  // A local const (rather than reading the module-level `let` back) avoids
  // TypeScript having to assume something else could have reassigned
  // sharedBrowser across the `await`s below - which can't actually happen
  // in single-threaded Node, but TS can't know that for a mutable outer-
  // scope variable.
  const browser = await Camoufox(os ? { headless, os } : { headless });
  sharedBrowser = browser;

  const userAgent = loadUserAgent();
  if (userAgent) console.error(`[cf] using stored User-Agent: ${userAgent}`);
  const context = await browser.newContext(userAgent ? { userAgent } : {});
  sharedContext = context;

  const cookies = loadCookies();
  if (cookies) await context.addCookies(cookies).catch(() => {});
  return context;
}

// Separate browser for providers that must egress through PROXY_URL (see
// NOTES.md - 1337x bans our IPv4 but not our IPv6, and the Colima VM has no
// IPv6 of its own). Playwright's Firefox wants the proxy set at launch, so
// this is a second browser rather than a second context.
async function getProxyContext(): Promise<BrowserContext | null> {
  if (proxyContext) return proxyContext;
  if (!PROXY_URL) return null;
  if (!proxyContextPromise) {
    proxyContextPromise = launchProxyContext().catch((err) => {
      proxyContextPromise = null;
      throw err;
    });
  }
  return proxyContextPromise;
}

async function launchProxyContext(): Promise<BrowserContext | null> {
  // Non-null: only called from getProxyContext(), which already checked
  // PROXY_URL - narrowing just doesn't carry across the function boundary.
  const proxyUrl = PROXY_URL!;
  console.error(`[cf] launching proxied browser via ${proxyUrl}`);
  const headless = process.platform === 'linux' ? false : true;
  // A literal object argument at the call site (rather than a pre-built
  // `opts` variable) matters here: Camoufox()'s return type is generic on
  // whether user_data_dir is present, and extracting the parameter type
  // separately loses that inference, resolving to BrowserContext instead of
  // Browser.
  const browser = process.platform === 'linux'
    ? await Camoufox({ headless, proxy: { server: proxyUrl }, os: 'linux' })
    : await Camoufox({ headless, proxy: { server: proxyUrl } });
  proxyBrowser = browser;
  const context = await browser.newContext();
  proxyContext = context;
  return context;
}

// fetchCfProtectedPage()'s options - a standard RequestInit (method/headers/
// body/etc, same as the global fetch()) plus two extras of our own, so the
// function is otherwise a drop-in replacement for fetch() minus getting a
// live Response back (this always resolves the body text directly instead -
// see fetchCfProtectedPage's own doc comment for why).
export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  /** Route through PROXY_URL. Pass the provider's id (so PROXY_PROVIDERS can
   * target it) or `true` for an unnamed request. */
  proxy?: boolean | string;
}

// Shared by fetchCfProtectedPage()'s slow path: navigates
// `page` to `url` and waits/solves until past Cloudflare, returning the
// cleared HTML. Throws (does NOT close the page - caller's responsibility)
// if the challenge doesn't clear within the timeout or the site hard-blocks
// us. Doesn't open/close pages or pick a context itself, just the
// navigate+wait+solve+verify dance, so both callers - one using a fresh
// page, the other a long-lived persistent one - share identical behavior.
async function navigateOnce(page: Page, url: string, timeoutMs: number): Promise<string> {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });

  const waitUntilCleared = async (ms: number): Promise<string> => {
    const deadline = Date.now() + ms;
    let html = await safeContent(page);
    while ((isChallenge(html) || !html) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      html = await safeContent(page);
    }
    return html;
  };

  // A stored cf_clearance cookie usually means no challenge at all, so give
  // it a short pass first before spending time on the solve routine.
  let html = await waitUntilCleared(8000);

  if (isChallenge(html) || !html) {
    if (await serializeSolve(() => autoSolveChallenge(page))) {
      html = await waitUntilCleared(timeoutMs);

      // Clearing the challenge only means the interstitial is gone. Cloudflare
      // then redirects to the URL we actually asked for, and returning before
      // that lands hands the caller a blank page - which looks exactly like
      // "the site returned 0 results".
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      html = await safeContent(page);
    }
  }

  if (isChallenge(html) || !html) {
    console.error(`[cf] still challenged (challenge=${isChallenge(html)}, htmlLen=${html.length}).`);
    throw new Error('Cloudflare challenge did not clear (auto-solve failed).');
  }

  if (isBlocked(html)) {
    console.error(`[cf] hard blocked (Cloudflare access denied page, htmlLen=${html.length}).`);
    throw new Error('Blocked by Cloudflare (IP ban/rate limit) - not a solvable challenge, needs a different IP or time to cool down.');
  }

  return html;
}

// A Cloudflare failure - challenge that didn't clear, or a hard block -
// has been observed live to sometimes be transient: a request that fails
// once can succeed again moments later with nothing else changed
// (confirmed: a hard-blocked request recovered on a plain retry a few
// seconds afterwards). Rather than surface that as a client-visible
// failure and rely on the caller (Prowlarr) to notice and retry the whole
// request itself, retry the whole navigation once, inline, right here -
// fresh page.goto, fresh challenge/block check, fresh solve attempt if
// needed. Only surfaces an error if that retry ALSO fails.
async function navigateAndClear(page: Page, url: string, timeoutMs: number): Promise<string> {
  try {
    const html = await navigateOnce(page, url, timeoutMs);
    console.error('[cf] cleared.');
    return html;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cf] navigation failed (${message}), retrying once...`);
    const html = await navigateOnce(page, url, timeoutMs);
    console.error('[cf] cleared on retry.');
    return html;
  }
}

// Resolves which context (direct vs proxy) a request should use, and
// whether that's actually the proxy context (a provider can ask for the
// proxy and still end up direct, if it isn't allow-listed - see
// proxyEnabledFor above). Used by getOrCreatePersistentPage() so every
// fetchCfProtectedPage() call for a given hostname picks its context the
// same way.
async function resolveContext(proxy: boolean | string): Promise<{ context: BrowserContext; usingProxy: boolean }> {
  const wants = typeof proxy === 'string' ? proxy : proxy ? '*' : null;
  const useProxy = proxyEnabledFor(wants);
  const context = (useProxy ? await getProxyContext() : null) || (await getPersistentContext());
  const usingProxy = useProxy && context === proxyContext;
  if (wants && !usingProxy) {
    console.error(`[cf] proxy not enabled for '${wants}', using a direct connection.`);
  }
  return { context, usingProxy };
}

// One already-cleared, long-lived page per hostname, reused across many
// requests instead of opening/closing a fresh page per call - lets
// listing-page fetches skip full navigation (see fetchCfProtectedPage).
// Keyed by hostname rather than a caller-supplied provider id - every
// current provider only ever talks to one hostname, so this partitions
// exactly the same way while removing a redundant parameter every caller
// would otherwise have to pass and keep in sync with the URLs it fetches.
const persistentPages = new Map<string, { page: Page; usingProxy: boolean }>();

async function getOrCreatePersistentPage(hostname: string, proxy: boolean | string): Promise<{ page: Page; usingProxy: boolean }> {
  const existing = persistentPages.get(hostname);
  if (existing && !existing.page.isClosed()) return existing;

  const { context, usingProxy } = await resolveContext(proxy);
  const page = await context.newPage();
  const entry = { page, usingProxy };
  persistentPages.set(hostname, entry);
  return entry;
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

// Cache for fetchCfProtectedPage()'s results. Separate cache from the
// search-result cache that used to live in server.ts (removed - this one,
// sitting right at the fetch itself, is what now makes a repeat request
// for the same site page a no-op, regardless of which offset/limit window
// the caller asked for it under). Keyed by a hash of method+url+body, not
// just the URL - a GET is idempotent so the URL alone would be a fine key,
// but a POST's response depends on its body too (e.g. ext.to's magnet POST
// carries a different torrent id and a fresh per-call HMAC on every
// request to the *same* endpoint URL - caching by URL alone would serve
// one torrent's magnet response for a completely different torrent).
const PAGE_CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MS) || 5 * 60 * 1000;
const pageCache = new TTLCache<string>(PAGE_CACHE_TTL_MS);

// General-purpose Cloudflare-aware fetch: no live page is handed back,
// just the response text, and it's cached. The in-page fetch() itself can
// be any method (opts.method/headers/body) - this covers AJAX endpoints
// that need real cookies/origin (e.g. ext.to's magnet POST, EZTV's
// wlinks-reveal POST) just as well as plain listing-page GETs, as long as
// the caller accepts a cached response is possible for a repeated
// identical call (see the cache key note above).
//
// Fast path: try the fetch through the hostname's already-cleared
// persistent page instead of a fresh navigation - skips the full page
// load/render cost of page.goto() entirely when the session's still good.
// Slow path (fetch failed outright, or came back challenged/blocked - the
// session needs refreshing): for a GET, navigate that SAME persistent page
// directly to `url` - this both re-solves the session AND gets the real
// content we wanted in one step, no need to fetch() again afterwards. For
// anything else (a POST to an AJAX endpoint isn't a page you can
// meaningfully navigate to), instead reload wherever the page currently is
// to re-solve the session, then retry the original fetch once - clearing a
// challenge is a session-wide cookie fix, not tied to which specific page
// on the origin you're looking at.
//
// This recovery is per-request, not tied to the periodic keep-alive tick -
// if the session goes stale between ticks, the very next real request
// self-heals inline instead of waiting for the next scheduled check.
// Concurrent recovery attempts still queue behind serializeNav/serializeSolve,
// so two requests hitting a stale session at once don't both try to solve it.
export async function fetchCfProtectedPage(url: string, opts: FetchOptions = {}): Promise<string> {
  const { timeoutMs = 30000, proxy = false, method = 'GET', headers, body } = opts;
  const init: RequestInit = { method, headers, body };
  const isGet = method.toUpperCase() === 'GET';
  const cacheKey = crypto.createHash('sha256').update(`${method}:${url}:${body ?? ''}`).digest('hex');

  const cached = pageCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const { page, usingProxy } = await getOrCreatePersistentPage(new URL(url).hostname, proxy);

  const fast = await tryFetch(page, url, init);
  if (fast !== null && !isChallenge(fast) && !isBlocked(fast)) {
    pageCache.set(cacheKey, fast);
    return fast;
  }

  console.error(`[cf] fetchCfProtectedPage: fast path unavailable for ${url}, recovering session.`);

  // Navigate purely to clear the challenge / re-establish session cookies -
  // for a GET this is the target url itself (which also gives the page
  // real same-path context some endpoints apparently require - confirmed
  // live for EZTV's reveal POST, see providers/eztv.ts). For anything else,
  // `url` isn't necessarily something you can navigate to at all (an AJAX
  // POST endpoint) - reload wherever the page is already sitting instead,
  // falling back to the request's own origin root if it has no real
  // history yet (about:blank - a brand new persistent page whose very
  // first call happens to be a non-GET).
  //
  // Either way, the navigation's own returned HTML is discarded on
  // purpose and never treated as the answer - only a fresh fetch()
  // afterward is trusted. A page fresh off a solved challenge can still be
  // mid-redirect/mid-render in ways the networkidle wait inside
  // navigateAndClear doesn't always fully close out; a real subsequent
  // fetch() for the exact thing we actually asked for is the only thing
  // that's unambiguously safe to hand back, whether that's a GET or not.
  const currentUrl = page.url();
  const navigateTarget = isGet ? url : currentUrl && currentUrl !== 'about:blank' ? currentUrl : new URL(url).origin + '/';
  await serializeNav(usingProxy, () => navigateAndClear(page, navigateTarget, timeoutMs));
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
  if (proxyBrowser) await proxyBrowser.close().catch(() => {});
  proxyBrowser = null;
  proxyContext = null;
  if (sharedBrowser) await sharedBrowser.close();
  sharedBrowser = null;
  sharedContext = null;
}
