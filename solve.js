#!/usr/bin/env node

/**
 * Interactive Cloudflare solver, meant to run INSIDE the container.
 *
 * Cloudflare won't render a Turnstile widget for an automated browser at
 * all (see the investigation notes in lib/browser.js), so the clearance
 * cookie has to be earned by a human clicking once. A cf_clearance cookie
 * is validated against the OS/TCP fingerprint of the machine it was issued
 * to, so a cookie solved in a macOS browser is rejected when replayed from
 * a Linux container - it has to be solved from the same kernel/network
 * stack that will later use it, i.e. in here.
 *
 * This runs a real (non-headless) browser on a virtual X display, which
 * x11vnc exposes on :5900 so you can connect and click the checkbox. Once
 * the challenge clears, the cookies and the exact User-Agent they were
 * issued to are written to DATA_DIR for the server to reuse.
 *
 * Usage (see Dockerfile.solver):
 *   docker run --rm -p 5900:5900 -v ext-to-data:/data ext-to-solver
 *   then open  vnc://localhost:5900  and click the checkbox
 */

import fs from 'fs';
import path from 'path';
import { Camoufox } from 'camoufox-js';

const DATA_DIR = process.env.DATA_DIR || '/data';
const COOKIE_FILE = path.join(DATA_DIR, '.cf-cookies.json');
const UA_FILE = path.join(DATA_DIR, '.cf-ua.txt');
const TARGET = process.env.SOLVE_URL || 'https://ext.to/browse/?q=yify';
const TIMEOUT_MS = Number(process.env.SOLVE_TIMEOUT_MS) || 300000;

function isChallenge(html) {
  return html.includes('cf-turnstile') || html.includes('Just a moment');
}

async function safeContent(page) {
  try {
    return await page.content();
  } catch {
    return '';
  }
}

// Pin the OS so the fingerprint (and therefore the User-Agent the cookie
// gets bound to) matches the Linux container the server runs in. Camoufox
// otherwise randomises this per launch, which would invalidate the cookie.
const browser = await Camoufox({ headless: false, os: 'linux' });
const context = await browser.newContext();
const page = await context.newPage();

const userAgent = await page.evaluate(() => navigator.userAgent);
console.log('User-Agent:', userAgent);
console.log(`Opening ${TARGET}`);
console.log('>>> Connect to vnc://localhost:5900 and click the Cloudflare checkbox. <<<');

await page.goto(TARGET, { waitUntil: 'load', timeout: 60000 });

const deadline = Date.now() + TIMEOUT_MS;
let html = await safeContent(page);
let tick = 0;
while ((isChallenge(html) || !html) && Date.now() < deadline) {
  tick++;
  if (tick % 5 === 0) {
    const left = Math.round((deadline - Date.now()) / 1000);
    console.log(`  ...waiting for you to solve it (${left}s left)`);
  }
  await new Promise((r) => setTimeout(r, 1000));
  html = await safeContent(page);
}

if (isChallenge(html) || !html) {
  console.error('Timed out waiting for the challenge to be solved.');
  await browser.close();
  process.exit(1);
}

const cookies = await context.cookies();
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
fs.writeFileSync(UA_FILE, userAgent);

console.log('Solved. Saved:');
console.log(`  ${COOKIE_FILE} (${cookies.map((c) => c.name).join(', ')})`);
console.log(`  ${UA_FILE}`);
await browser.close();
process.exit(0);
