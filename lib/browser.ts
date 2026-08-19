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

// In-flight launch promise, so concurrent first calls (e.g. the 4 parallel
// fetchCfProtectedPage() calls from a multi-category browse) await the same
// launch instead of each seeing sharedContext still null and racing to start
// their own browser. That race was observed live: multiple simultaneous
// "launching browser" attempts, several Camoufox/Firefox instances fighting
// over one Xvfb display, and a page.goto NS_ERROR_NET_TIMEOUT.
let persistentContextPromise: Promise<BrowserContext> | null = null;

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
// navigations at once, and live-testing found that 2+ concurrent navigations
// to the same Cloudflare-protected host reliably hang until the 60s
// page.goto timeout, even though each one succeeds fine on its own. Queuing
// navigations one at a time on the shared context fixes it, at the cost of
// the rare multi-category blank-browse case taking roughly N times as long
// as a single-category one instead of running in parallel. One browser now
// handles both direct and proxied traffic (see DOMAIN_OVER_PROXY below), so
// there's a single chain rather than one per egress path.
let navChain: Promise<unknown> = Promise.resolve();

function serializeNav<T>(task: () => Promise<T>): Promise<T> {
  const run = navChain.then(task, task);
  navChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

// Optional upstream proxy, for domains that can't be reached directly (see
// NOTES.md - 1337x bans our IPv4, and the container has no IPv6 of its own).
//
//   PROXY_URL         e.g. http://tinyproxy:8888. Unset = the proxy is
//                     disabled entirely and everything goes direct.
//   DOMAIN_OVER_PROXY comma-separated hostnames routed through it (matches
//                     the exact hostname or any of its subdomains). Unset or
//                     empty = none - deliberately opt-in, not opt-out, so a
//                     new domain never silently starts routing through a
//                     proxy an operator hasn't reviewed/configured for it.
//
// Routing is per-request, not per-provider: a single persistent browser is
// configured with a PAC script (see buildPacDataUri below) that Firefox
// itself evaluates for every request it makes, main navigation and every
// embedded sub-resource alike. That per-request granularity matters -
// 1337x.to's own page embeds Cloudflare's Turnstile widget, which loads its
// own assets from Cloudflare-owned hosts that can be IPv4-only; forcing
// *everything* the page touches through an IPv6-only proxy broke those
// unrelated hosts outright (see NOTES.md section 4). A provider-level flag
// can't express "proxy this hostname, not that one, even though a single
// page load touches both" - only a per-request decision inside the browser
// itself can, which is what the PAC script gives us instead of a bypass
// allowlist maintained here.
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
// through PROXY_URL and everything else direct. Playwright's own `proxy`
// launch option only supports the opposite shape (proxy by default, with a
// `bypass` exception list) - there's no way to express "direct by default,
// except these hosts" through it, so this goes around Playwright entirely
// and drives Firefox's native network.proxy.* prefs instead (see
// launchPersistentContext). Returns null when no proxying is configured.
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

  // xdotool's own arg parser reads a leading "-" as the start of an option
  // flag, not a negative number - "mousemove -38 100" fails with
  // "unrecognized option '-38'" instead of moving there, silently doing
  // nothing (live-observed in the click-approach steps below, whose
  // offsets can push cx+dx/cy+dy negative when the widget renders near the
  // screen edge). Clamped to 0 rather than passed through some "--"
  // end-of-options marker - there's no meaningful off-screen position on
  // our single-screen Xvfb display anyway, so 0 is both a safe substitute
  // and never ambiguous with an option flag.
  const move = (x: number, y: number): boolean => xdo(['mousemove', String(Math.max(0, x)), String(Math.max(0, y))]);

  if (!xdo(['getdisplaygeometry'])) {
    console.error('[cf] xdotool unavailable, cannot auto-solve.');
    return false;
  }

  console.error('[cf] auto-solving challenge (X-level input)...');

  // Movement warm-up: this is what gets the widget past "Verifying...".
  for (let i = 0; i < 30; i++) {
    move(300 + Math.round(Math.sin(i / 4) * 250) + i * 8, 300 + Math.round(Math.cos(i / 5) * 160));
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

  const clickCheckbox = async (): Promise<void> => {
    for (const [dx, dy, wait] of [
      [-150, -80, 350],
      [-60, -25, 300],
      [-12, -4, 250],
      [0, 0, 500]
    ] as const) {
      move(cx + dx, cy + dy);
      await new Promise((r) => setTimeout(r, wait));
    }
    xdo(['click', '1']);
  };

  // Solved state shows up as a token in the hidden response input before
  // the page moves on - a cheap, targeted check we can poll without waiting
  // for a full page transition. If a click didn't register (the widget
  // just sits on "Verifying..." with no progress - live-observed via
  // screenshot: the checkbox hadn't even rendered yet at click time, so the
  // click lands on nothing), click again - observed the same
  // click-doesn't-always-land behavior in another Turnstile solver
  // (byparr's own logs show it clicking twice, ~6s apart, before its
  // challenge clears - not unique to this widget/site). Bounded to a few
  // clicks rather than one retry, since how long the widget takes to
  // render varies with how loaded the machine is.
  const MAX_CLICKS = 3;
  const CLICK_INTERVAL_MS = 6000;

  const hasToken = () =>
    page
      .evaluate(() => {
        const input = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
        return !!input?.value;
      })
      .catch(() => false);

  for (let click = 1; click <= MAX_CLICKS; click++) {
    await clickCheckbox();
    if (click === MAX_CLICKS) break;
    await new Promise((r) => setTimeout(r, CLICK_INTERVAL_MS));
    if (await hasToken()) break;
    console.error(`[cf] no progress after click ${click}, retrying (click ${click + 1}/${MAX_CLICKS})...`);
  }

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
// body/etc, same as the global fetch()) plus one extra of our own, so the
// function is otherwise a drop-in replacement for fetch() minus getting a
// live Response back (this always resolves the body text directly instead -
// see fetchCfProtectedPage's own doc comment for why). No `proxy` field -
// routing is decided per-hostname by the PAC script (see DOMAIN_OVER_PROXY
// above), not per-call.
export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
}

// Shared by fetchCfProtectedPage()'s slow path: navigates
// `page` to `url` and waits/solves until past Cloudflare, returning the
// cleared HTML. Throws (does NOT close the page - caller's responsibility)
// if the challenge doesn't clear within the timeout or the site hard-blocks
// us. Doesn't open/close pages or pick a context itself, just the
// navigate+wait+solve+verify dance, so both callers - one using a fresh
// page, the other a long-lived persistent one - share identical behavior.
//
// `alreadyConfirmedChallenged`: set when fetchCfProtectedPage's own
// origin-establishing domcontentloaded navigation (see there) already ran
// moments ago AND its own same-origin fetch() check already came back
// challenged - i.e. we already have a fresh, real signal that solving is
// needed, not a guess. In that case there's no point doing a second fresh
// page.goto() (we're already on the right page, just extend the wait to
// 'load' instead of re-navigating) or giving it another 8s passive chance
// to have self-resolved (empirically, across every case observed so far,
// it never has once a real challenge is confirmed present - the passive
// wait only ever helps the "already cleared" case, which the origin-check
// fetch() would have already caught on its own).
async function navigateOnce(page: Page, url: string, timeoutMs: number, alreadyConfirmedChallenged = false): Promise<string> {
  if (alreadyConfirmedChallenged) {
    await page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
  } else {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  }

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
  // it a short pass first before spending time on the solve routine - unless
  // we already know better (see above).
  let html = alreadyConfirmedChallenged ? await safeContent(page) : await waitUntilCleared(8000);

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
async function navigateAndClear(page: Page, url: string, timeoutMs: number, alreadyConfirmedChallenged = false): Promise<string> {
  try {
    const html = await navigateOnce(page, url, timeoutMs, alreadyConfirmedChallenged);
    console.error('[cf] cleared.');
    return html;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cf] navigation failed (${message}), retrying once...`);
    // The retry always does a full fresh navigateOnce (no shortcut) - the
    // moments-old "already confirmed challenged" signal is stale by now,
    // and a genuinely fresh page.goto + passive wait is the more robust
    // fallback once the fast path has already been tried and failed once.
    const html = await navigateOnce(page, url, timeoutMs);
    console.error('[cf] cleared on retry.');
    return html;
  }
}

// One already-cleared, long-lived page per hostname, reused across many
// requests instead of opening/closing a fresh page per call - lets
// listing-page fetches skip full navigation (see fetchCfProtectedPage).
// Keyed by hostname rather than a caller-supplied provider id - every
// current provider only ever talks to one hostname, so this partitions
// exactly the same way while removing a redundant parameter every caller
// would otherwise have to pass and keep in sync with the URLs it fetches.
//
// Every hostname shares the same underlying browser/context now - routing
// through the proxy or not is the PAC script's per-request decision, not a
// separate context to pick between (see DOMAIN_OVER_PROXY above). usingProxy
// is still tracked per page, purely so fetchCfProtectedPage knows whether to
// persist this hostname's cookies (see the note at that call site: a
// proxy-obtained cf_clearance is bound to the proxy's egress IP, and
// shouldn't get mixed into the same cookie file a direct-egress domain like
// ext.to relies on).
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
  const { timeoutMs = 30000, method = 'GET', headers, body } = opts;
  const init: RequestInit = { method, headers, body };
  const isGet = method.toUpperCase() === 'GET';
  const cacheKey = crypto.createHash('sha256').update(`${method}:${url}:${body ?? ''}`).digest('hex');

  const cached = pageCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const { page, usingProxy } = await getOrCreatePersistentPage(new URL(url).hostname);

  // A brand-new page starts at about:blank, where fetch()'s same-origin
  // credential/CORS rules mean tryFetch() below is guaranteed to fail no
  // matter how valid the domain's cookies already are - not a real signal
  // that a challenge is present, just this check being unable to run yet.
  // A cheap domcontentloaded navigation (far less work than the full 'load'
  // the slow path below uses) gets the page onto the real origin first, so
  // tryFetch has an actual chance to succeed instead of failing
  // unconditionally on every hostname's first-ever call. On every call
  // after that first one, the page is already on the right origin from a
  // prior navigation and this is a no-op.
  let justNavigated = false;
  if (page.url() === 'about:blank') {
    const originTarget = isGet ? url : new URL(url).origin + '/';
    try {
      await page.goto(originTarget, { waitUntil: 'domcontentloaded', timeout: 60000 });
      justNavigated = true;
    } catch {
      // Fall through - the slow path below does a full fresh navigation
      // regardless, so a failed cheap pre-nav just means we skip the
      // optimization for this call, not that the request fails outright.
    }
  }

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
  // first call happens to be a non-GET, and the pre-nav above didn't run
  // or failed).
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
  await serializeNav(() => navigateAndClear(page, navigateTarget, timeoutMs, justNavigated));
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
