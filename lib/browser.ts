import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Camoufox } from 'camoufox-js';
import type { Browser, BrowserContext, Cookie, Page } from 'playwright-core';

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

// Optional upstream proxy, for providers that can't be reached directly
// (see NOTES.md - 1337x bans our IPv4, and the container has no IPv6).
//
//   PROXY_URL        e.g. http://host.docker.internal:8888. Unset = the
//                    proxy is disabled entirely and everything goes direct.
//   PROXY_PROVIDERS  comma-separated provider ids allowed to use it. Unset
//                    or empty = none - a provider asking for the proxy in
//                    code (gotoCleared(url, {proxy: 'id'})) is not enough on
//                    its own, it must be explicitly allow-listed here too.
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
  console.error(`[cf] launching proxied browser via ${PROXY_URL}`);
  const headless = process.platform === 'linux' ? false : true;
  // A literal object argument at the call site (rather than a pre-built
  // `opts` variable) matters here: Camoufox()'s return type is generic on
  // whether user_data_dir is present, and extracting the parameter type
  // separately loses that inference, resolving to BrowserContext instead of
  // Browser.
  const browser = process.platform === 'linux'
    ? await Camoufox({ headless, proxy: { server: PROXY_URL }, os: 'linux' })
    : await Camoufox({ headless, proxy: { server: PROXY_URL } });
  proxyBrowser = browser;
  const context = await browser.newContext();
  proxyContext = context;
  return context;
}

export interface GotoOptions {
  timeoutMs?: number;
  /** Route through PROXY_URL. Pass the provider's id (so PROXY_PROVIDERS can
   * target it) or `true` for an unnamed request. */
  proxy?: boolean | string;
}

// Navigates a fresh page (in the shared headless context) to `url` and
// returns it once past Cloudflare. Throws if the challenge doesn't clear
// within the timeout - caller/Prowlarr is expected to retry later. Caller
// is responsible for closing the returned page (but NOT the shared
// browser/context).
//
// opts.proxy asks to route through PROXY_URL. Pass the provider's id (so
// PROXY_PROVIDERS can target it) or `true` for an unnamed request. Whether
// it actually happens is decided by the env vars above - a provider asking
// for a proxy that isn't configured silently goes direct.
export async function gotoCleared(url: string, opts: GotoOptions | number = {}): Promise<Page> {
  const { timeoutMs = 30000, proxy = false } = typeof opts === 'number' ? { timeoutMs: opts, proxy: false as const } : opts;
  const wants = typeof proxy === 'string' ? proxy : proxy ? '*' : null;
  const useProxy = proxyEnabledFor(wants);

  console.error(`[cf] gotoCleared: ${url}${useProxy ? ` (via proxy ${PROXY_URL})` : ''}`);

  const context = (useProxy ? await getProxyContext() : null) || (await getPersistentContext());
  const usingProxy = useProxy && context === proxyContext;
  if (wants && !usingProxy) {
    console.error(`[cf] proxy not enabled for '${wants}', using a direct connection.`);
  }

  const page = await context.newPage();
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
    await page.close();
    throw new Error('Cloudflare challenge did not clear (auto-solve failed).');
  }

  if (isBlocked(html)) {
    console.error(`[cf] hard blocked (Cloudflare access denied page, htmlLen=${html.length}).`);
    await page.close();
    throw new Error('Blocked by Cloudflare (IP ban/rate limit) - not a solvable challenge, needs a different IP or time to cool down.');
  }

  console.error('[cf] cleared.');
  // Only the direct context's cookies are persisted - the cookie file holds
  // ext.to's cf_clearance, and saving the proxied context over it would
  // clobber it with another site's cookies.
  if (!usingProxy) saveCookies(await context.cookies());
  return page;
}

export async function closeBrowser(): Promise<void> {
  if (proxyBrowser) await proxyBrowser.close().catch(() => {});
  proxyBrowser = null;
  proxyContext = null;
  if (sharedBrowser) await sharedBrowser.close();
  sharedBrowser = null;
  sharedContext = null;
}
