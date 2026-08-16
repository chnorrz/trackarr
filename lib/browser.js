import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Camoufox } from 'camoufox-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DATA_DIR is configurable so it can point at a mounted volume in Docker -
// otherwise cookies are lost on every container restart, forcing a cold
// Cloudflare clearance with no manual-solve fallback available.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const COOKIE_FILE = path.join(DATA_DIR, '.cf-cookies.json');

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

let sharedBrowser = null;
let sharedContext = null;

// Persistent headless browser/context, reused across requests so we don't
// pay browser-startup cost per request. No GUI available (runs in Docker),
// so there is no manual-solve fallback - we rely entirely on Cloudflare's
// invisible/managed Turnstile mode auto-passing for a clean-fingerprint
// headless browser. If it doesn't, the request just fails and the caller
// (Prowlarr) retries on its next scheduled poll.
async function getPersistentContext() {
  if (sharedContext) return sharedContext;
  // 'virtual' (Xvfb-backed) mode is only supported on Linux, and is what
  // gives Firefox a real WebGL context to render with (see Dockerfile for
  // why plain `headless: true` fails Cloudflare's bot checks). On macOS
  // (local dev) plain headless already has real WebGL, so just use that.
  const headless = process.platform === 'linux' ? 'virtual' : true;
  sharedBrowser = await Camoufox({ headless });
  sharedContext = await sharedBrowser.newContext();
  const cookies = loadCookies();
  if (cookies) await sharedContext.addCookies(cookies).catch(() => {});
  return sharedContext;
}

// Navigates a fresh page (in the shared headless context) to `url` and
// returns it once past Cloudflare. Throws if the challenge doesn't clear
// within the timeout - caller/Prowlarr is expected to retry later. Caller
// is responsible for closing the returned page (but NOT the shared
// browser/context).
export async function gotoCleared(url, timeoutMs = 30000) {
  console.error(`[cf] gotoCleared: ${url}`);
  const context = await getPersistentContext();

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  const deadline = Date.now() + timeoutMs;
  let html = await safeContent(page);
  while ((isChallenge(html) || !html) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    html = await safeContent(page);
  }

  if (isChallenge(html) || !html) {
    console.error(`[cf] still challenged (challenge=${isChallenge(html)}, htmlLen=${html.length}).`);
    await page.close();
    throw new Error('Cloudflare challenge did not clear automatically (no GUI to solve it manually).');
  }

  if (isBlocked(html)) {
    console.error(`[cf] hard blocked (Cloudflare access denied page, htmlLen=${html.length}).`);
    await page.close();
    throw new Error('Blocked by Cloudflare (IP ban/rate limit) - not a solvable challenge, needs a different IP or time to cool down.');
  }

  console.error('[cf] cleared.');
  saveCookies(await context.cookies());
  return page;
}

export async function closeBrowser() {
  if (sharedBrowser) await sharedBrowser.close();
  sharedBrowser = null;
  sharedContext = null;
}
