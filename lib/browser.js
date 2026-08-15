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
  sharedBrowser = await Camoufox({ headless: true });
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

  console.error('[cf] cleared.');
  saveCookies(await context.cookies());
  return page;
}

export async function closeBrowser() {
  if (sharedBrowser) await sharedBrowser.close();
  sharedBrowser = null;
  sharedContext = null;
}
