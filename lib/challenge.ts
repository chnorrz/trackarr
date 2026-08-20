import { execFileSync } from 'child_process';
import type { Page } from 'playwright-core';

// Solve-loop timing. See NOTES.md section 6 for where these came from -
// WARMUP_MOVES in particular is measured, not arbitrary.
const POLL_INTERVAL_MS = 250;
const PROBE_INTERVAL_MS = 500;
const CLICK_COOLDOWN_MS = 4000;
const SOLVE_BUDGET_MS = 45000;
const WANDER_INTERVAL_MS = 100;
const WARMUP_MOVES = 30;
const INIT_PAGE_TIMEOUT_MS = 15000;

interface WidgetGeo {
  offX: number;
  offY: number;
  rect: { x: number; y: number; h: number } | null;
}

interface FirefoxWindow extends Window {
  mozInnerScreenX: number;
  mozInnerScreenY: number;
}

interface Pointer {
  clickAt: (cx: number, cy: number) => Promise<void>;
  wanderFor: (ms: number) => Promise<void>;
}

interface CfWidget {
  clickOnce: (pointer: Pointer) => Promise<void>;
}

export function isChallenge(html: string): boolean {
  return html.includes('cf-turnstile') || html.includes('Just a moment');
}

export function isBlocked(html: string): boolean {
  return html.includes('Access denied') && html.includes('Cloudflare');
}

// Never throws - an empty string means "couldn't read the page", which the
// callers treat as "not a challenge". page.url() is itself guarded: it
// throws too once the page/context is gone, and that would escape from
// inside this catch block and defeat the whole point of the helper.
async function safeContent(page: Page): Promise<string> {
  try {
    return await page.content();
  } catch (error) {
    let where = 'unknown';
    try {
      where = page.url();
    } catch {
      /* page or context already gone */
    }
    console.error(`[cf] page.content() failed (url=${where}):`, error);
    return '';
  }
}

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

  const move = (x: number, y: number): boolean => xdo(['mousemove', String(Math.max(0, x)), String(Math.max(0, y))]);

  if (!xdo(['getdisplaygeometry'])) {
    console.error('[cf] xdotool unavailable, cannot auto-solve.');
    return null;
  }

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

  const wanderFor = async (ms: number): Promise<void> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      wander();
      await new Promise((r) => setTimeout(r, Math.min(WANDER_INTERVAL_MS, end - Date.now())));
    }
  };

  return { wanderFor, clickAt };
}

// Returns null when the widget isn't in the DOM yet - not an error, it can
// still be rendering (or the challenge may have cleared on its own), so the
// caller should probe again shortly rather than treat this as failure.
async function locateCfWidget(page: Page): Promise<CfWidget | null> {
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
    return null;
  }

  // Checkbox sits at the left edge of the widget, vertically centred.
  const cx = Math.round(geo.offX + geo.rect.x + 22);
  const cy = Math.round(geo.offY + geo.rect.y + geo.rect.h / 2);

  const clickOnce = async (pointer: Pointer): Promise<void> => {
    console.error(`[cf] clicking checkbox at screen ${cx},${cy}`);
    await pointer.clickAt(cx, cy);
  };

  return { clickOnce };
}

// Confirms the challenge is really gone and not just between navigations -
// checks twice, POLL_INTERVAL_MS apart, since a page caught mid-redirect
// can transiently read as cleared.
async function challengeIsGone(page: Page, pointer: Pointer): Promise<boolean> {
  if (isChallenge(await safeContent(page))) return false;
  await pointer.wanderFor(POLL_INTERVAL_MS);
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
export async function solveChallenge(page: Page): Promise<void> {
  const html = await safeContent(page);

  if (!isChallenge(html)) {
    throw new Error(
      `Cloudflare fetch failed and the page shows no solvable challenge ` +
        `(htmlLen=${html.length}) - likely a hard block (IP ban/rate limit) or an unrelated failure.`
    );
  }

  const pointer = createPointer();

  if (!pointer) {
    throw new Error('Cloudflare challenge present but no DISPLAY/xdotool available to solve it.');
  }

  console.error('[cf] auto-solving challenge (X-level input)...');
  const solveStart = Date.now();
  await pointer.wanderFor(WARMUP_MOVES * WANDER_INTERVAL_MS);

  const deadline = solveStart + SOLVE_BUDGET_MS;
  let nextClickAt = 0;

  while (Date.now() < deadline) {
    if (await challengeIsGone(page, pointer)) {
      console.error(`[cf] challenge cleared after ${Date.now() - solveStart}ms.`);
      return;
    }

    if (Date.now() >= nextClickAt) {
      const widget = await locateCfWidget(page);
      if (widget) await widget.clickOnce(pointer);
      nextClickAt = Date.now() + (widget ? CLICK_COOLDOWN_MS : PROBE_INTERVAL_MS);
    }

    await pointer.wanderFor(POLL_INTERVAL_MS);
  }

  throw new Error(`Cloudflare challenge did not clear.`);
}
