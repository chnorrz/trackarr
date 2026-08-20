import { execFileSync } from 'child_process';
import type { Page } from 'playwright-core';

// Cloudflare challenge detection and solving. Everything here is about the
// interstitial itself - lib/browser.ts owns the browser session, page reuse
// and the actual fetching, and calls solveChallenge() when a fetch comes
// back challenged.
//
// solveChallenge() must be called under the caller's solve mutex: XTEST
// input is global to the X display, so two solves running at once fight
// over the same virtual mouse and both fail (see serializeSolve in
// lib/browser.ts).

export function isChallenge(html: string): boolean {
  // Note: 'challenge-platform' is NOT a reliable marker - Cloudflare injects a
  // bot-management beacon script (/cdn-cgi/challenge-platform/scripts/jsd/main.js)
  // on legit, already-cleared pages too, causing false positives.
  return html.includes('cf-turnstile') || html.includes('Just a moment');
}

// A hard Cloudflare deny (IP ban/rate limit, error 1006/1015/etc.) is a
// static error page - no Turnstile widget, so isChallenge() doesn't catch
// it. Left undetected, this silently looks like a real "cleared" page with
// zero search results instead of a clear failure.
export function isBlocked(html: string): boolean {
  return html.includes('Access denied') && html.includes('Cloudflare');
}

async function safeContent(page: Page): Promise<string> {
  try {
    return await page.content();
  } catch {
    return '';
  }
}

interface WidgetGeo {
  offX: number;
  offY: number;
  rect: { x: number; y: number; h: number } | null;
}

// mozInnerScreenX/Y are Firefox-only, not in lib.dom.d.ts (which models a
// more Chromium-shaped Window) - findWidgetGeo()'s page.evaluate() callback
// runs inside Firefox itself (see solveChallenge's own doc comment on why
// page coords need this offset), so they're genuinely present at runtime
// despite TS not knowing about them.
interface FirefoxWindow extends Window {
  mozInnerScreenX: number;
  mozInnerScreenY: number;
}

interface Pointer {
  wander: () => void;
  clickAt: (cx: number, cy: number) => Promise<void>;
}

// Sets up XTEST-level mouse control on DISPLAY (via xdotool, not
// Playwright's own mouse API - that leaves the widget stuck on
// "Verifying..." forever and never offering a checkbox). Returns null if
// there's no DISPLAY or xdotool isn't reachable - the caller can't solve
// anything in that case.
function createPointer(): Pointer | null {
  const display = process.env.DISPLAY;
  if (!display) return null;

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
  // nothing (live-observed in clickAt's approach steps below, whose offsets
  // can push cx+dx/cy+dy negative when the widget renders near the screen
  // edge). Clamped to 0 rather than passed through some "--" end-of-options
  // marker - there's no meaningful off-screen position on our single-screen
  // Xvfb display anyway, so 0 is both a safe substitute and never ambiguous
  // with an option flag.
  const move = (x: number, y: number): boolean => xdo(['mousemove', String(Math.max(0, x)), String(Math.max(0, y))]);

  if (!xdo(['getdisplaygeometry'])) {
    console.error('[cf] xdotool unavailable, cannot auto-solve.');
    return null;
  }

  // Bounded, continuous wander path - this is what gets the widget past
  // "Verifying...". Used both for the initial warm-up sweep and to keep
  // some movement going between click attempts while waiting for the
  // widget to render. Bounded (no drift term) so it stays safe to call
  // indefinitely.
  let wanderTick = 0;
  const wander = (): void => {
    const i = wanderTick++;
    move(300 + Math.round(Math.sin(i / 4) * 250), 300 + Math.round(Math.cos(i / 5) * 160));
  };

  const clickAt = async (cx: number, cy: number): Promise<void> => {
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

  return { wander, clickAt };
}

// Coordinates are SCREEN space (xdotool) vs PAGE space
// (getBoundingClientRect()) - Firefox's window chrome offsets the content
// area, so raw page coords land above the checkbox. See NOTES.md section 6
// for the full empirical writeup. Returns null if the widget isn't in the
// DOM yet - not itself an error, the caller decides what to do about it.
async function findWidgetGeo(page: Page): Promise<{ cx: number; cy: number } | null> {
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
  if (!geo || !geo.rect) return null;
  // Checkbox sits at the left edge of the widget, vertically centred.
  return { cx: Math.round(geo.offX + geo.rect.x + 22), cy: Math.round(geo.offY + geo.rect.y + geo.rect.h / 2) };
}

// Looks for the widget and clicks it once if found. Returns false (not an
// error - the widget can still be rendering, especially under load) when
// there's nothing to click yet, so the caller knows to probe again shortly
// instead of waiting out a full click cooldown for nothing.
async function clickWidgetOnce(page: Page, pointer: Pointer): Promise<boolean> {
  const widget = await findWidgetGeo(page);
  if (!widget) return false;
  console.error(`[cf] clicking checkbox at screen ${widget.cx},${widget.cy}`);
  await pointer.clickAt(widget.cx, widget.cy);
  return true;
}

const POLL_INTERVAL_MS = 250;
const PROBE_INTERVAL_MS = 500;
const CLICK_COOLDOWN_MS = 4000;
const SOLVE_BUDGET_MS = 45000;
const WANDER_INTERVAL_MS = 100;
// Moves before the first widget check. Measured, don't drop this: an 18-run
// A/B (3 per arm per provider, alternated) found that removing it inverts
// the click count - with the warm-up 7 of 9 solves land on the first click,
// without it 7 of 9 need a second. Saving 3s upfront to then wait out a 4s
// CLICK_COOLDOWN_MS is a net loss, and the overall median got worse (7.5s ->
// 9.0s). See NOTES.md section 6.
const WARMUP_MOVES = 30;

// Keeps the mouse moving for `ms` instead of sleeping idle - every wait
// inside a solve goes through this, so movement stays continuous at
// WANDER_INTERVAL_MS cadence for the whole solve rather than only during an
// upfront warm-up burst.
async function wanderFor(pointer: Pointer, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    pointer.wander();
    await new Promise((r) => setTimeout(r, Math.min(WANDER_INTERVAL_MS, end - Date.now())));
  }
}

// Confirms the challenge is really gone and not just between navigations -
// checks twice, POLL_INTERVAL_MS apart, since a page caught mid-redirect
// can transiently read as cleared.
async function challengeIsGone(page: Page, pointer: Pointer): Promise<boolean> {
  if (isChallenge(await safeContent(page))) return false;
  await wanderFor(pointer, POLL_INTERVAL_MS);
  return !isChallenge(await safeContent(page));
}

// Waits out the Cloudflare interstitial on `page`, clicking its checkbox
// whenever one is offered, until the challenge clears or the budget runs
// out. Doesn't navigate anywhere itself - once cleared, the caller's own
// tryFetch() picks up wherever Cloudflare's own post-solve redirect landed
// the page. An earlier version issued its own page.goto() reload here
// instead of waiting for that redirect - live-observed to sometimes race
// it and hang for the full 60s page.goto timeout (the same class of bug
// NOTES.md section 6 documents for concurrent navigations generally). Not
// navigating at all sidesteps the race instead of trying to win it.
// Approach (widget polling, probe-vs-cooldown timing) matches another
// Turnstile solver (byparr, github.com/ThePhaseless/Byparr): treat "no
// widget yet" as "try again shortly", never as terminal failure - only the
// overall budget running out is failure.
export async function solveChallenge(page: Page, url: string): Promise<void> {
  await page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});
  const html = await safeContent(page);

  if (!isChallenge(html)) {
    throw new Error(
      `Cloudflare fetch failed for ${url} and the page shows no solvable challenge ` +
        `(htmlLen=${html.length}) - likely a hard block (IP ban/rate limit) or an unrelated failure.`
    );
  }

  const pointer = createPointer();
  if (!pointer) throw new Error('Cloudflare challenge present but no DISPLAY/xdotool available to solve it.');

  console.error('[cf] auto-solving challenge (X-level input)...');
  const solveStart = Date.now();
  await wanderFor(pointer, WARMUP_MOVES * WANDER_INTERVAL_MS);

  const deadline = solveStart + SOLVE_BUDGET_MS;
  let nextClickAt = 0;

  while (Date.now() < deadline) {
    if (await challengeIsGone(page, pointer)) {
      console.error(`[cf] challenge cleared after ${Date.now() - solveStart}ms.`);
      return;
    }

    if (Date.now() >= nextClickAt) {
      const clicked = await clickWidgetOnce(page, pointer);
      nextClickAt = Date.now() + (clicked ? CLICK_COOLDOWN_MS : PROBE_INTERVAL_MS);
    }

    await wanderFor(pointer, POLL_INTERVAL_MS);
  }

  throw new Error(`Cloudflare challenge did not clear for ${url}.`);
}
