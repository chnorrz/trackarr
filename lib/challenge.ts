import { execFileSync, spawn, type ChildProcess } from 'child_process';
import type { Page } from 'playwright-core';

// Solve-loop timing. See NOTES.md section 6 for where these came from.
const POLL_INTERVAL_MS = 250;
const PROBE_INTERVAL_MS = 500;
const CLICK_COOLDOWN_MS = 4000;
const SOLVE_BUDGET_MS = 45000;
const MOVE_SETTLE_MS = 60;
const CLEAR_SETTLE_MS = 1500;
const NAV_QUIET_MS = 500;
const NAV_SETTLE_TIMEOUT_MS = 8000;
const MIN_WIDGET_HEIGHT = 20;
const MAX_WIDGET_HEIGHT = 120;
const MIN_WIDGET_WIDTH = 40;
const CHECKBOX_INSET = 25;
const WIDGET_ANCESTOR_DEPTHS = [1, 2, 3, 4];
const BOX_READ_TIMEOUT_MS = 1000;
const TURNSTILE_INPUT = 'input[name="cf-turnstile-response"]';
const CHALLENGE_INDICATORS = `${TURNSTILE_INPUT}, .cf-turnstile, #challenge-form, #challenge-running`;

interface WidgetPos {
  cx: number;
  cy: number;
}

interface Pointer {
  clickAt: (measure: () => Promise<WidgetPos | null>) => Promise<void>;
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

let xdoProc: ChildProcess | null = null;

function xdoStream(env: NodeJS.ProcessEnv): ((line: string) => void) | null {
  if (!xdoProc || xdoProc.exitCode !== null || xdoProc.killed || !xdoProc.stdin?.writable) {
    try {
      const proc = spawn('xdotool', ['-'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
      proc.on('error', () => {
        if (xdoProc === proc) xdoProc = null;
      });
      proc.on('exit', () => {
        if (xdoProc === proc) xdoProc = null;
      });
      proc.unref();
      xdoProc = proc;
    } catch {
      return null;
    }
  }

  const proc = xdoProc;
  if (!proc?.stdin?.writable) return null;

  return (line: string): void => {
    try {
      proc.stdin?.write(`${line}\n`);
    } catch {
      xdoProc = null;
    }
  };
}

function createPointer(): Pointer | null {
  const display = process.env.DISPLAY;
  if (!display) return null;

  const env = { ...process.env, DISPLAY: display };

  try {
    // we could do this with "coop: false" of camoufox and then page.mouse.click, 
    // but cloudflare might be able to detect that
    execFileSync('xdotool', ['getdisplaygeometry'], { env });
  } catch {
    console.error('[cf] xdotool unavailable, cannot auto-solve.');
    return null;
  }

  const stream = xdoStream(env);
  if (!stream) {
    console.error('[cf] xdotool unavailable, cannot auto-solve.');
    return null;
  }

  const clickAt = async (measure: () => Promise<WidgetPos | null>): Promise<void> => {
    const target = await measure();
    if (!target) return;

    stream(`mousemove ${Math.max(0, target.cx)} ${Math.max(0, target.cy)}`);
    await new Promise((r) => setTimeout(r, MOVE_SETTLE_MS));
    stream('click 1');
  };

  return { clickAt };
}

// Measured with locators, not page.evaluate: running a script in the page
// resets the challenge, so the widget never settles into a clickable state.
async function measureWidgetPos(page: Page): Promise<WidgetPos | null> {
  const offset = await screenOffset(page);
  if (!offset) return null;

  for (const depth of WIDGET_ANCESTOR_DEPTHS) {
    const widget = page.locator(`${TURNSTILE_INPUT} >> xpath=ancestor::div[${depth}]`);
    try {
      if ((await widget.count()) === 0) continue;
      const box = await widget.first().boundingBox({ timeout: BOX_READ_TIMEOUT_MS });
      if (!box) continue;
      if (box.width < MIN_WIDGET_WIDTH) continue;
      if (box.height < MIN_WIDGET_HEIGHT || box.height > MAX_WIDGET_HEIGHT) continue;

      // Checkbox sits at the left edge of the widget, vertically centred.
      return {
        cx: Math.round(offset.x + box.x + CHECKBOX_INSET),
        cy: Math.round(offset.y + box.y + box.height / 2)
      };
    } catch {
      continue;
    }
  }
  return null;
}

async function locateCfWidget(page: Page): Promise<CfWidget | null> {
  const pos = await measureWidgetPos(page);

  if (!pos) return null;

  const clickOnce = async (pointer: Pointer): Promise<void> => {
    console.error(`[cf] clicking checkbox at screen ${pos.cx},${pos.cy}`);
    await pointer.clickAt(() => measureWidgetPos(page));
  };

  return { clickOnce };
}

async function challengeVisible(page: Page): Promise<boolean> {
  return page
    .locator(CHALLENGE_INDICATORS)
    .count()
    .then((n) => n > 0)
    .catch(() => false);
}

let cachedOffset: { x: number; y: number } | null = null;

async function screenOffset(page: Page): Promise<{ x: number; y: number } | null> {
  if (cachedOffset) return cachedOffset;
  const read = await page
    .evaluate(() => {
      const win = window as unknown as { mozInnerScreenX: number; mozInnerScreenY: number };
      return { x: win.mozInnerScreenX, y: win.mozInnerScreenY };
    })
    .catch(() => null);
  if (read) cachedOffset = read;
  return read;
}

// Clearing the interstitial only starts Cloudflare's own client-side redirect
// back to the requested URL, and that chain can have several hops. Returning
// mid-chain hands the caller a page that navigates out from under its next
// fetch ("fetch failed even after session recovery").
//
// Both halves are needed. The floor is because quiescence alone cannot tell
// "the redirect finished" from "the redirect hasn't started yet" - waiting on
// navigation events alone returned immediately and failed 2 of 3 live. The
// quiet window is because a fixed wait alone is a guess - 1.5s covered most
// solves but not all, live-observed failing on 1337x.
async function waitForRedirectChain(page: Page): Promise<void> {
  let lastNavAt = 0;
  const onNavigated = (frame: unknown): void => {
    if (frame === page.mainFrame()) lastNavAt = Date.now();
  };
  page.on('framenavigated', onNavigated);

  try {
    await new Promise((r) => setTimeout(r, CLEAR_SETTLE_MS));

    const deadline = Date.now() + NAV_SETTLE_TIMEOUT_MS;
    while (Date.now() < deadline && lastNavAt !== 0 && Date.now() - lastNavAt < NAV_QUIET_MS) {
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    // The page outlives the solve, so a listener left behind would accumulate
    // one per challenge for the life of the process.
    page.off('framenavigated', onNavigated);
  }

  await page.waitForLoadState('load', { timeout: NAV_SETTLE_TIMEOUT_MS }).catch(() => {});
}

// Confirms the challenge is really gone and not just between navigations -
// checks twice, POLL_INTERVAL_MS apart, since a page caught mid-redirect
// can transiently read as cleared.
async function challengeIsGone(page: Page): Promise<boolean> {
  if (await challengeVisible(page)) return false;
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  return !(await challengeVisible(page));
}

async function getClearanceCookie(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const value = cookies.find((c) => c.name === 'cf_clearance')?.value;
  if (value === undefined) {
    console.error('[cf] challenge cleared per page content, but no cf_clearance cookie found in the jar.');
    return '';
  }
  return value;
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
export async function solveChallenge(page: Page): Promise<string> {
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

  const deadline = solveStart + SOLVE_BUDGET_MS;
  let nextClickAt = 0;

  while (Date.now() < deadline) {
    if (await challengeIsGone(page)) {
      console.error(`[cf] challenge cleared after ${Date.now() - solveStart}ms.`);
      await waitForRedirectChain(page);
      return getClearanceCookie(page);
    }

    if (Date.now() >= nextClickAt) {
      const widget = await locateCfWidget(page);
      if (widget) await widget.clickOnce(pointer);
      nextClickAt = Date.now() + (widget ? CLICK_COOLDOWN_MS : PROBE_INTERVAL_MS);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`Cloudflare challenge did not clear.`);
}
