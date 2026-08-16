import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Camoufox } from 'camoufox-js';

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

function isChallenge(html) {
  // Note: 'challenge-platform' is NOT a reliable marker - Cloudflare injects a
  // bot-management beacon script (/cdn-cgi/challenge-platform/scripts/jsd/main.js)
  // on legit, already-cleared pages too, causing false positives.
  return html.includes('cf-turnstile') || html.includes('Just a moment');
}

// A hard Cloudflare deny (IP ban/rate limit, error 1006/1015/etc.) is a
// static error page - no Turnstile widget, so isChallenge() doesn't catch
// it. Left undetected, this silently looks like a real "cleared" page with
// zero search results instead of a clear failure.
function isBlocked(html) {
  return html.includes('Access denied') && html.includes('Cloudflare');
}

async function safeContent(page) {
  try {
    return await page.content();
  } catch {
    return '';
  }
}

function loadCookies() {
  try {
    return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveCookies(cookies) {
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
}

function loadUserAgent() {
  try {
    return fs.readFileSync(UA_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

let sharedBrowser = null;
let sharedContext = null;
let proxyBrowser = null;
let proxyContext = null;

// Optional upstream proxy, for providers that can't be reached directly
// (see NOTES.md - 1337x bans our IPv4, and the container has no IPv6).
//
//   PROXY_URL        e.g. http://host.docker.internal:8888. Unset = the
//                    proxy is disabled entirely and everything goes direct.
//   PROXY_PROVIDERS  comma-separated provider ids, to override which ones
//                    use it. Unset = whichever providers ask for it in code.
//                    Set but empty = none (a kill switch without having to
//                    unset PROXY_URL).
const PROXY_URL = process.env.PROXY_URL || null;
const PROXY_PROVIDERS = process.env.PROXY_PROVIDERS === undefined
  ? null
  : process.env.PROXY_PROVIDERS.split(',').map((s) => s.trim()).filter(Boolean);

function proxyEnabledFor(who) {
  if (!PROXY_URL || !who) return false;
  if (PROXY_PROVIDERS === null) return true;
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
async function autoSolveChallenge(page) {
  const display = process.env.DISPLAY;
  if (!display) return false;

  const xdo = (args) => {
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
    xdo(['mousemove',
      String(300 + Math.round(Math.sin(i / 4) * 250) + i * 8),
      String(300 + Math.round(Math.cos(i / 5) * 160))]);
    await new Promise((r) => setTimeout(r, 100));
  }

  const geo = await page.evaluate(() => {
    const el = document.querySelector('[id^=cf-chl-widget], .cf-turnstile, #mZiFs3');
    const r = el ? el.getBoundingClientRect() : null;
    return {
      offX: window.mozInnerScreenX,
      offY: window.mozInnerScreenY,
      rect: r ? { x: r.x, y: r.y, h: r.height } : null
    };
  }).catch(() => null);

  if (!geo || !geo.rect) {
    console.error('[cf] no Turnstile widget found to click.');
    return false;
  }

  // Checkbox sits at the left edge of the widget, vertically centred.
  const cx = Math.round(geo.offX + geo.rect.x + 22);
  const cy = Math.round(geo.offY + geo.rect.y + geo.rect.h / 2);
  console.error(`[cf] clicking checkbox at screen ${cx},${cy}`);

  for (const [dx, dy, wait] of [[-150, -80, 350], [-60, -25, 300], [-12, -4, 250], [0, 0, 500]]) {
    xdo(['mousemove', String(cx + dx), String(cy + dy)]);
    await new Promise((r) => setTimeout(r, wait));
  }
  xdo(['click', '1']);
  return true;
}

// Persistent browser/context, reused across requests so we don't pay
// browser-startup cost per request.
async function getPersistentContext() {
  if (sharedContext) return sharedContext;
  // On Linux we run a real (non-headless) browser against the Xvfb display
  // in DISPLAY. Camoufox's own 'virtual' mode would also use Xvfb, but at
  // 1x1 resolution, leaving no room to render/click the Turnstile widget.
  // On macOS (local dev) plain headless is fine.
  const headless = process.platform === 'linux' ? false : true;
  // Pin the spoofed OS so it stays consistent with the UA the stored
  // cf_clearance cookie was issued to (see UA_FILE above).
  const os = process.platform === 'linux' ? 'linux' : undefined;
  sharedBrowser = await Camoufox(os ? { headless, os } : { headless });

  const userAgent = loadUserAgent();
  if (userAgent) console.error(`[cf] using stored User-Agent: ${userAgent}`);
  sharedContext = await sharedBrowser.newContext(userAgent ? { userAgent } : {});

  const cookies = loadCookies();
  if (cookies) await sharedContext.addCookies(cookies).catch(() => {});
  return sharedContext;
}

// Separate browser for providers that must egress through PROXY_URL (see
// NOTES.md - 1337x bans our IPv4 but not our IPv6, and the Colima VM has no
// IPv6 of its own). Playwright's Firefox wants the proxy set at launch, so
// this is a second browser rather than a second context.
async function getProxyContext() {
  if (proxyContext) return proxyContext;
  if (!PROXY_URL) return null;
  console.error(`[cf] launching proxied browser via ${PROXY_URL}`);
  const headless = process.platform === 'linux' ? false : true;
  const opts = { headless, proxy: { server: PROXY_URL } };
  if (process.platform === 'linux') opts.os = 'linux';
  proxyBrowser = await Camoufox(opts);
  proxyContext = await proxyBrowser.newContext();
  return proxyContext;
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
export async function gotoCleared(url, opts = {}) {
  const { timeoutMs = 30000, proxy = false } = typeof opts === 'number' ? { timeoutMs: opts } : opts;
  const wants = typeof proxy === 'string' ? proxy : (proxy ? '*' : null);
  const useProxy = proxyEnabledFor(wants);

  console.error(`[cf] gotoCleared: ${url}${useProxy ? ' (via proxy)' : ''}`);

  const context = (useProxy ? await getProxyContext() : null) || await getPersistentContext();
  const usingProxy = useProxy && context === proxyContext;
  if (wants && !usingProxy) {
    console.error(`[cf] proxy not enabled for '${wants}', using a direct connection.`);
  }

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });

  const waitUntilCleared = async (ms) => {
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
    if (await autoSolveChallenge(page)) {
      html = await waitUntilCleared(timeoutMs);
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

export async function closeBrowser() {
  if (proxyBrowser) await proxyBrowser.close().catch(() => {});
  proxyBrowser = null;
  proxyContext = null;
  if (sharedBrowser) await sharedBrowser.close();
  sharedBrowser = null;
  sharedContext = null;
}
