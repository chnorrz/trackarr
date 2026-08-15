#!/usr/bin/env node

/**
 * Fetches a magnet link from an ext.to torrent page.
 *
 * ext.to sits behind Cloudflare Turnstile. Plain requests get a 403.
 * Puppeteer/Chromium (even stealth-patched) gets stuck in an endless
 * "click checkbox -> reprompt" loop because Cloudflare detects the CDP
 * `Runtime.enable` call Puppeteer makes internally, regardless of a real
 * click. Camoufox sidesteps this: it's a patched real Firefox binary with
 * fingerprint spoofing baked in at the engine level, driven over
 * Playwright's Firefox protocol (no Chrome CDP leak).
 *
 * IMPORTANT: cf_clearance is bound to the browser's TLS fingerprint, not
 * just the cookie value - it cannot be lifted out and replayed through
 * Node's plain fetch (different TLS stack -> 403 again). So the whole
 * flow, including the magnet POST, runs *inside* the browser page via
 * page.evaluate(fetch), never through Node's own fetch.
 *
 * Flow:
 *   1. Launch Camoufox headless, restore cached cookies into the context
 *      (skips the challenge entirely if they're still valid).
 *   2. If still challenged, retry visible and wait for you to click once.
 *   3. Extract torrent_id / pageToken / csrfToken from the live page.
 *   4. Run the HMAC POST via page.evaluate(fetch) - same TLS session.
 *   5. Save fresh cookies to .cf-cookies.json for next time.
 *
 * Usage:
 *   node get-magnet.js "https://ext.to/torrent-slug-1234567/"
 *
 * Deps:
 *   npm install cheerio camoufox-js "playwright-core@<1.61.0"
 *   npx camoufox-js fetch   # downloads the Camoufox browser binary once
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import * as cheerio from 'cheerio';
import { Camoufox } from 'camoufox-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE = 'https://ext.to';
const ENDPOINT = `${BASE}/ajax/getTorrentMagnet.php`;
const COOKIE_FILE = path.join(__dirname, '.cf-cookies.json');

function computeHMAC(torrentId, timestamp, token) {
  const data = `${torrentId}|${timestamp}|${token}`;
  return crypto.createHash('sha256').update(data).digest('hex');
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

// Launches Camoufox, restores cached cookies, and waits for the Cloudflare
// challenge to clear (automatically if possible, otherwise with a visible
// window for a manual click). Returns the still-open browser/context/page
// so the caller can keep using the same TLS session for the actual request.
async function openCleared(pageUrl) {
  const savedCookies = loadCookies();

  for (const headless of [true, false]) {
    const browser = await Camoufox({ headless });
    const context = await browser.newContext();
    if (savedCookies) {
      await context.addCookies(savedCookies).catch(() => {});
    }
    const page = await context.newPage();

    if (!headless) {
      console.error('Still blocked. Opening a visible browser - please solve the challenge there...');
    } else {
      console.error('Loading page (headless)...');
    }

    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 60000 });

    const cleared = await page
      .waitForFunction(() => !document.title.includes('Just a moment'), {
        timeout: headless ? 20000 : 120000
      })
      .then(() => true)
      .catch(() => false);

    if (cleared) {
      return { browser, context, page };
    }

    await browser.close();
  }

  throw new Error('Could not clear the Cloudflare challenge (headless or manual).');
}

async function getMagnet(pageUrl) {
  const { browser, context, page } = await openCleared(pageUrl);

  try {
    const html = await page.content();

    // Extract torrent id + tokens
    const $ = cheerio.load(html);
    const torrentIdAttr =
      $('[data-id][class*="magnet" i]').first().attr('data-id') ||
      $('[data-id][onclick*="agnet"]').first().attr('data-id') ||
      $('[data-id]').first().attr('data-id');

    const torrentId = parseInt(torrentIdAttr, 10);
    if (!torrentId) {
      throw new Error(
        'Could not find data-id on page. Selector may need adjusting to match current markup.'
      );
    }

    const pageTokenMatch = html.match(/pageToken\s*=\s*['"]([^'"]+)['"]/);
    const csrfTokenMatch = html.match(/csrfToken\s*=\s*['"]([^'"]+)['"]/);
    if (!pageTokenMatch) throw new Error('Could not find window.pageToken in page HTML.');
    if (!csrfTokenMatch) throw new Error('Could not find window.csrfToken in page HTML.');

    const pageToken = pageTokenMatch[1];
    const sessid = csrfTokenMatch[1];

    // Compute HMAC
    const timestamp = Math.floor(Date.now() / 1000);
    const hmac = computeHMAC(torrentId, timestamp, pageToken);

    // Fire the POST from inside the page - same TLS session/cookies as the
    // cleared Cloudflare challenge.
    const result = await page.evaluate(
      async ({ endpoint, torrentId, timestamp, hmac, sessid }) => {
        const body = new URLSearchParams({
          torrent_id: String(torrentId),
          action: 'get_magnet',
          timestamp: String(timestamp),
          hmac,
          sessid
        });
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          body
        });
        const text = await res.text();
        return { status: res.status, text };
      },
      { endpoint: ENDPOINT, torrentId, timestamp, hmac, sessid }
    );

    let json;
    try {
      json = JSON.parse(result.text);
    } catch {
      throw new Error(`Non-JSON response (status ${result.status}): ${result.text.slice(0, 300)}`);
    }

    const magnet = json.magnet || json.data?.magnet || json.data;
    if (!magnet || typeof magnet !== 'string' || !magnet.startsWith('magnet:')) {
      throw new Error(`No magnet in response: ${JSON.stringify(json)}`);
    }

    // Save fresh cookies for next run (may skip the challenge entirely).
    saveCookies(await context.cookies());

    return magnet;
  } finally {
    await browser.close();
  }
}

// CLI entry
const url = process.argv[2];
if (!url) {
  console.error('Usage: node get-magnet.js <ext.to torrent url>');
  process.exit(1);
}

getMagnet(url)
  .then((magnet) => console.log(magnet))
  .catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
