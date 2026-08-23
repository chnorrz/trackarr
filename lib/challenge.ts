import { execFileSync, spawn, type ChildProcess } from 'child_process';
import type { Page, Response as PlaywrightResponse } from 'playwright-core';

const POLL_INTERVAL_MS = 250;
const PROBE_INTERVAL_MS = 500;
const CLICK_COOLDOWN_MS = 4000;
const SOLVE_BUDGET_MS = 45000;
const MOVE_SETTLE_MS = 60;
const NAV_SETTLE_TIMEOUT_MS = 8000;
const MIN_WIDGET_HEIGHT = 20;
const MAX_WIDGET_HEIGHT = 120;
const MIN_WIDGET_WIDTH = 40;
const CHECKBOX_INSET = 25;
const WIDGET_ANCESTOR_DEPTHS = [1, 2, 3, 4];
const BOX_READ_TIMEOUT_MS = 1000;
const TURNSTILE_INPUT = 'input[name="cf-turnstile-response"]';
// `__cf_chl_rt_tk` fires within ~100ms and means nothing; `__cf_chl_tk` is the
// hop that completes the challenge. Either one means we are still mid-chain.
const CHALLENGE_URL_TOKEN = '__cf_chl';

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

// page.url() needs its own guard: it also throws once the page/context is
// gone, which would escape from inside this catch block.
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
    // X-level input rather than camoufox "coop: false" + page.mouse.click,
    // which Cloudflare might be able to detect.
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

interface ChallengeWatch {
  cleared: () => boolean;
  dispose: () => void;
}

// Both signals are required: the clearing response arrives while the page is
// still on a `__cf_chl` URL, and that URL goes clean long before it is solved.
function watchChallenge(page: Page): ChallengeWatch {
  let sawClearingResponse = false;

  const onResponse = (res: PlaywrightResponse): void => {
    try {
      if (res.frame() !== page.mainFrame()) return;
      if (!res.request().isNavigationRequest()) return;
      sawClearingResponse = res.headers()['cf-mitigated'] !== 'challenge';
    } catch {
      /* response already gone */
    }
  };

  page.on('response', onResponse);

  return {
    cleared: () => {
      if (!sawClearingResponse) return false;
      try {
        return !page.url().includes(CHALLENGE_URL_TOKEN);
      } catch {
        return false;
      }
    },
    dispose: () => page.off('response', onResponse)
  };
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

// Scoped to this URL's origin: unscoped, context.cookies() returns every
// domain's cookies and can report another tracker's clearance as this result.
async function getClearanceCookie(page: Page): Promise<string> {
  const url = page.url();
  const cookies = await page.context().cookies(url).catch(() => []);
  const value = cookies.find((c) => c.name === 'cf_clearance')?.value;
  if (value === undefined) {
    console.error(`[cf] challenge cleared but no cf_clearance cookie found for ${url}.`);
    return '';
  }
  return value;
}

// Deliberately never navigates: an own page.goto() here races Cloudflare's
// post-solve redirect and hangs for the full goto timeout.
export async function solveChallenge(page: Page): Promise<string> {
  // Attached before anything else so no navigation response is missed.
  const watch = watchChallenge(page);

  try {
    const html = await safeContent(page);

    if (isBlocked(html)) {
      throw new Error(
        `Cloudflare hard block (IP ban/rate limit) - no challenge to solve (htmlLen=${html.length}).`
      );
    }

    if (html && !isChallenge(html)) {
      return await getClearanceCookie(page);
    }

    const pointer = createPointer();

    if (!pointer) {
      throw new Error('Cloudflare challenge present but no DISPLAY/xdotool available to solve it.');
    }

    console.error('[cf] auto-solving challenge (X-level input)...');
    const solveStart = Date.now();

    const deadline = solveStart + SOLVE_BUDGET_MS;
    let nextClickAt = 0;
    let clicks = 0;
    let widgetSeen = false;

    while (Date.now() < deadline) {
      if (watch.cleared()) {
        console.error(`[cf] challenge cleared after ${Date.now() - solveStart}ms (${clicks} clicks).`);
        await page.waitForLoadState('load', { timeout: NAV_SETTLE_TIMEOUT_MS }).catch(() => {});
        return await getClearanceCookie(page);
      }

      if (Date.now() >= nextClickAt) {
        const widget = await locateCfWidget(page);
        if (widget) {
          widgetSeen = true;
          clicks++;
          await widget.clickOnce(pointer);
        }
        nextClickAt = Date.now() + (widget ? CLICK_COOLDOWN_MS : PROBE_INTERVAL_MS);
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    const stuck = widgetSeen
      ? `widget rendered and was clicked ${clicks}x but Cloudflare never let a navigation through`
      : 'no widget ever rendered and the challenge never self-cleared';
    throw new Error(`Cloudflare challenge did not clear after ${SOLVE_BUDGET_MS}ms: ${stuck}.`);
  } finally {
    watch.dispose();
  }
}
