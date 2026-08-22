// Throwaway diagnostic - NOT part of the build. See NOTES.md section 8.
//
// Answers two blocked questions about 1337x's challenge in one run:
//   1. WHICH selectors identify a *non-interactive* Cloudflare challenge?
//      lib/challenge.ts's CHALLENGE_INDICATORS are Turnstile-only, so a
//      challenge with no checkbox reads as "cleared" on the first poll.
//   2. HOW LONG does it actually take to self-clear? That sets the solve
//      budget and the page.goto timeout.
//
// Usage (debug container on the homelab, NOT the live server - a second
// Camoufox on the same Xvfb causes the exact hangs we're diagnosing):
//
//   docker run -d --name trackarr-dbg --network <trackarr-net> \
//     -e PROXY_URL=http://tinyproxy:8888 -e DOMAIN_OVER_PROXY=1337x.to \
//     ghcr.io/chnorrz/trackarr:latest \
//     bash -c "Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX & sleep 2 && sleep 3600"
//
//   docker cp probe.js trackarr-dbg:/app/probe.js
//   docker exec -e DISPLAY=:99 trackarr-dbg node /app/probe.js
//   docker cp trackarr-dbg:/tmp/probe /tmp/probe   # screenshots + final HTML
//
// CONSTRAINT (NOTES.md section 6, requirement 1): page.evaluate() resets the
// challenge, and page.content() is evaluate underneath. The poll loop below
// therefore uses ONLY locators and page.url(). Screenshots are not page
// scripts and are safe. One content() dump happens after the loop ends.

import fs from 'fs';
import path from 'path';
import { Camoufox } from 'camoufox-js';

const URL_UNDER_TEST = process.env.PROBE_URL || 'https://1337x.to/';
const DURATION_MS = Number(process.env.PROBE_DURATION_MS) || 180000;
const POLL_MS = Number(process.env.PROBE_POLL_MS) || 500;
const SHOT_EVERY_MS = Number(process.env.PROBE_SHOT_MS) || 5000;
const OUT_DIR = process.env.PROBE_OUT || '/tmp/probe';

const PROXY_URL = process.env.PROXY_URL || null;
const DOMAIN_OVER_PROXY = (process.env.DOMAIN_OVER_PROXY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Element selectors. The first four are what lib/challenge.ts uses today;
// the rest are candidates seen in the interstitial shell, plus positive
// "we are actually through" markers for the real 1337x listing.
const SELECTORS = {
  'CURRENT turnstile-input': 'input[name="cf-turnstile-response"]',
  'CURRENT .cf-turnstile': '.cf-turnstile',
  'CURRENT #challenge-form': '#challenge-form',
  'CURRENT #challenge-running': '#challenge-running',
  '#challenge-stage': '#challenge-stage',
  '#challenge-error-text': '#challenge-error-text',
  '#challenge-error-title': '#challenge-error-title',
  '#challenge-body-text': '#challenge-body-text',
  '#cf-please-wait': '#cf-please-wait',
  '[id^=cf-chl-widget]': '[id^=cf-chl-widget]',
  '.main-wrapper': '.main-wrapper',
  '.main-content': '.main-content',
  'noscript': 'noscript',
  // The exact strings lib/challenge.ts now ships, verified end to end here.
  'NEW CF_INTERSTITIAL': '.main-wrapper[role="main"], #challenge-error-text, .ray-id',
  'NEW CHALLENGE_INDICATORS': 'input[name="cf-turnstile-response"], .cf-turnstile, #challenge-form, #challenge-running, .main-wrapper[role="main"], #challenge-error-text, .ray-id',
  'THROUGH table.table-list': 'table.table-list',
  'THROUGH a[href^=/torrent/]': 'a[href^="/torrent/"]'
};

// Visible-text markers, matched via locators (not evaluate).
const TEXTS = {
  'txt Just a moment': 'Just a moment',
  'txt Verifying you are human': 'Verifying you are human',
  'txt taking longer': 'verification taking longer',
  'txt Enable JavaScript': 'Enable JavaScript and cookies'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 23);

function buildPacDataUri() {
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

async function countAll(page) {
  const row = {};
  for (const [label, sel] of Object.entries(SELECTORS)) {
    row[label] = await page
      .locator(sel)
      .count()
      .catch(() => -1);
  }
  for (const [label, text] of Object.entries(TEXTS)) {
    row[label] = await page
      .getByText(text, { exact: false })
      .count()
      .catch(() => -1);
  }
  return row;
}

// Compact one-line signature: only labels with a non-zero count.
function signature(row, url) {
  const hits = Object.entries(row)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label}=${n}`)
    .join(' ');
  return `${url} :: ${hits || '(nothing matched)'}`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const pacDataUri = buildPacDataUri();
  console.log(`[probe] url=${URL_UNDER_TEST} duration=${DURATION_MS}ms poll=${POLL_MS}ms`);
  console.log(`[probe] proxy=${pacDataUri ? `${PROXY_URL} for [${DOMAIN_OVER_PROXY.join(', ')}]` : 'none (all direct)'}`);

  const headless = process.platform !== 'linux';
  const firefoxPrefs = pacDataUri
    ? { 'network.proxy.type': 2, 'network.proxy.autoconfig_url': pacDataUri }
    : undefined;

  // PROBE_CLICK=1 uses Playwright's own mouse instead of xdotool, so a
  // provider that needs a real click (ext.to) can be observed clearing on a
  // machine with no X display. Needs disable_coop - production deliberately
  // does NOT do this (NOTES.md section 6, requirement 2: COOP off is a
  // WAF-detectable tell). Diagnostic only.
  const useMouse = process.env.PROBE_CLICK === '1';
  const extra = useMouse ? { disable_coop: true } : {};

  const browser = process.platform === 'linux'
    ? await Camoufox({ headless, os: 'linux', window: [1280, 800], ...extra, ...(firefoxPrefs ? { firefox_user_prefs: firefoxPrefs } : {}) })
    : await Camoufox({ headless, window: [1280, 800], ...extra, ...(firefoxPrefs ? { firefox_user_prefs: firefoxPrefs } : {}) });

  const context = await browser.newContext();
  const page = await context.newPage();

  // Record every main-frame navigation - this is how we catch Cloudflare's
  // own auto-forward to the real site without polling for it.
  const navs = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      navs.push({ at: Date.now(), url: frame.url() });
      console.log(`[probe] ${ts()} NAV -> ${frame.url()}`);
    }
  });

  // Every main-frame navigation response, with the header browser.ts already
  // trusts. If cf-mitigated tracks the challenge reliably across the whole
  // redirect chain, it beats DOM sniffing: it is protocol-level, not markup,
  // so Cloudflare restyling the interstitial cannot break it.
  // Mirrors lib/challenge.ts's watchChallenge() exactly, so the shipped rule
  // can be timed against the real sites.
  let sawClearingResponse = false;
  const ruleCleared = () => {
    if (!sawClearingResponse) return false;
    try {
      return !page.url().includes('__cf_chl');
    } catch {
      return false;
    }
  };

  page.on('response', (res) => {
    try {
      if (res.frame() !== page.mainFrame()) return;
      if (!res.request().isNavigationRequest()) return;
      const mit = res.headers()['cf-mitigated'] ?? '(absent)';
      sawClearingResponse = mit !== 'challenge';
      console.log(`[probe] ${ts()} RESP status=${res.status()} cf-mitigated=${mit} ${res.url().slice(0, 90)}`);
    } catch { /* response gone */ }
  });

  const t0 = Date.now();
  console.log(`[probe] ${ts()} goto (waitUntil=commit, timeout=60000)`);
  try {
    const res = await page.goto(URL_UNDER_TEST, { waitUntil: 'commit', timeout: 60000 });
    const headers = res ? res.headers() : {};
    console.log(`[probe] ${ts()} goto committed in ${Date.now() - t0}ms status=${res ? res.status() : 'null'} cf-mitigated=${headers['cf-mitigated'] ?? '(absent)'}`);
  } catch (err) {
    console.log(`[probe] ${ts()} goto FAILED after ${Date.now() - t0}ms: ${err.message.split('\n')[0]}`);
    console.log('[probe] continuing to poll anyway - the page may still be loading');
  }

  // Optional: dump the interstitial's own HTML once, early, then exit. This
  // DOES reset the challenge (NOTES.md section 6, requirement 1), so it is a
  // separate throwaway run - never combine it with a timing measurement.
  const earlyDumpMs = Number(process.env.PROBE_EARLY_DUMP_MS) || 0;
  if (earlyDumpMs > 0) {
    await sleep(earlyDumpMs);
    const html = await page.content();
    fs.writeFileSync(path.join(OUT_DIR, 'interstitial.html'), html);
    console.log(`[probe] interstitial HTML at +${Date.now() - t0}ms: ${html.length} bytes -> ${OUT_DIR}/interstitial.html`);
    await page.screenshot({ path: path.join(OUT_DIR, 'interstitial.png') }).catch(() => {});
    await browser.close();
    process.exit(0);
  }

  const deadline = Date.now() + DURATION_MS;
  let lastSig = null;
  let nextShotAt = 0;
  let nextClickAt = 0;
  let shotN = 0;
  let clearedAt = null;

  while (Date.now() < deadline) {
    const elapsed = Date.now() - t0;
    let url = '(unavailable)';
    try {
      url = page.url();
    } catch { /* page gone */ }

    const row = await countAll(page);
    const sig = signature(row, url);

    if (sig !== lastSig) {
      console.log(`[probe] ${ts()} +${String(elapsed).padStart(6)}ms ${sig}`);
      lastSig = sig;
    }

    // First moment the real site is visible - this is the number that should
    // set SOLVE_BUDGET_MS.
    if (clearedAt === null && ruleCleared()) {
      clearedAt = elapsed;
      const stillChallenged = row['NEW CHALLENGE_INDICATORS'] > 0 || row['CURRENT turnstile-input'] > 0;
      console.log(`[probe] ${ts()} *** RULE SAYS CLEARED after ${elapsed}ms *** url=${url}`);
      console.log(`[probe]     sanity: interstitial markup still present? ${stillChallenged ? 'YES - RULE IS WRONG' : 'no - correct'}`);
    }

    // Click the widget on a cooldown, same cadence as the real solver, so the
    // clear event can be observed for providers that need it.
    if (useMouse && Date.now() >= nextClickAt) {
      let clicked = false;
      for (const depth of [1, 2, 3, 4]) {
        const w = page.locator(`input[name="cf-turnstile-response"] >> xpath=ancestor::div[${depth}]`);
        try {
          if ((await w.count()) === 0) continue;
          const box = await w.first().boundingBox({ timeout: 1000 });
          if (!box || box.width < 40 || box.height < 20 || box.height > 120) continue;
          const x = Math.round(box.x + 25);
          const y = Math.round(box.y + box.height / 2);
          console.log(`[probe] ${ts()} +${elapsed}ms CLICK page ${x},${y} (box ${Math.round(box.width)}x${Math.round(box.height)})`);
          await page.mouse.click(x, y);
          clicked = true;
          break;
        } catch { continue; }
      }
      nextClickAt = Date.now() + (clicked ? 4000 : 500);
    }

    if (Date.now() >= nextShotAt) {
      nextShotAt = Date.now() + SHOT_EVERY_MS;
      const file = path.join(OUT_DIR, `shot-${String(shotN++).padStart(3, '0')}-${elapsed}ms.png`);
      await page.screenshot({ path: file }).catch(() => {});
    }

    await sleep(POLL_MS);
  }

  // Loop is over - now it is safe to touch the page with scripts.
  console.log(`\n[probe] ===== SUMMARY =====`);
  console.log(`[probe] through at: ${clearedAt === null ? 'NEVER (still challenged at end)' : `${clearedAt}ms`}`);
  console.log(`[probe] main-frame navigations: ${navs.length}`);
  for (const n of navs) console.log(`[probe]   +${n.at - t0}ms ${n.url}`);

  const finalCounts = await countAll(page);
  console.log('[probe] final counts:');
  for (const [label, n] of Object.entries(finalCounts)) {
    console.log(`[probe]   ${n > 0 ? '*' : ' '} ${label.padEnd(30)} ${n}`);
  }

  try {
    const html = await page.content();
    fs.writeFileSync(path.join(OUT_DIR, 'final.html'), html);
    console.log(`[probe] final HTML: ${html.length} bytes -> ${OUT_DIR}/final.html`);
  } catch (err) {
    console.log(`[probe] final content() failed: ${err.message}`);
  }

  const cookies = await context.cookies(URL_UNDER_TEST).catch(() => []);
  console.log(`[probe] cookies scoped to ${URL_UNDER_TEST}:`);
  for (const c of cookies) {
    console.log(`[probe]   ${c.domain} ${c.name}=${String(c.value).slice(0, 12)}... expires=${c.expires}`);
  }

  console.log(`[probe] screenshots: ${OUT_DIR}/shot-*.png`);
  await browser.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('[probe] fatal:', err);
  process.exit(1);
});
