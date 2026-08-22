import { execFileSync, spawn, type ChildProcess } from 'child_process';
import type { Page, Response as PlaywrightResponse } from 'playwright-core';

// Solve-loop timing. See NOTES.md section 6 for where these came from.
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
// Cloudflare tags its own challenge navigations with these. `__cf_chl_rt_tk`
// fires within ~100ms of the interstitial and means nothing; `__cf_chl_tk` is
// the hop that actually completes the challenge. Either one means we are
// mid-chain and definitely not done - see NOTES.md section 6.
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

interface ChallengeWatch {
  cleared: () => boolean;
  dispose: () => void;
}

// Decides when the challenge is done, from two protocol-level signals only -
// no DOM inference, no fixed waits. Both are required; see NOTES.md section 6.
//
//   1. A main-frame navigation response arrived WITHOUT `cf-mitigated:
//      challenge`. That is Cloudflare saying it let this navigation through.
//      Status is deliberately ignored - EZTV clears via a 302, not a 200.
//   2. The current URL carries no `__cf_chl` token, so we are not mid-chain.
//
// Neither alone is enough. The clearing response arrives while the page is
// still sitting on the `__cf_chl_tk` URL and about to navigate once more, so
// trusting the header alone hands the caller a page that navigates out from
// under its next fetch. And the URL goes clean seconds before anything is
// solved, right after the meaningless `__cf_chl_rt_tk` hop, so trusting the
// URL alone reports success almost immediately.
//
// `page.on('response')` and `page.url()` are not page scripts, so this is
// safe under requirement 1 (page.evaluate resets the challenge).
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
    // The page outlives the solve, so a listener left behind would accumulate
    // one per challenge for the life of the process.
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

// Scoped to this URL's origin. Unscoped, context.cookies() returns every
// domain's cookies and find() can report another tracker's clearance as this
// solve's result - live-observed, with one unchanged value logged as
// "obtained" across several consecutive failed 1337x solves.
async function getClearanceCookie(page: Page): Promise<string> {
  // Only called once the challenge has cleared, which by definition means
  // page.url() is a real, settled, token-free URL on the host whose session
  // we just established.
  const url = page.url();
  const cookies = await page.context().cookies(url).catch(() => []);
  const value = cookies.find((c) => c.name === 'cf_clearance')?.value;
  if (value === undefined) {
    console.error(`[cf] challenge cleared but no cf_clearance cookie found for ${url}.`);
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
  // Attached before anything else so no navigation response is missed.
  const watch = watchChallenge(page);

  try {
    const html = await safeContent(page);

    // A hard block has no widget, so clicking can never help - fail loudly.
    if (isBlocked(html)) {
      throw new Error(
        `Cloudflare hard block (IP ban/rate limit) - no challenge to solve (htmlLen=${html.length}).`
      );
    }

    // Real content and no challenge markers: nothing to do. Usually a
    // concurrent request for the same host already cleared it while we waited
    // on the solve mutex - fetchMergedBrowse fires several cfFetch calls that
    // share one page, so the second one arrives to find the work done.
    // Live-caught on multi-category browse: htmlLen=622095, a full ext.to
    // listing, reported as "no solvable challenge". The caller re-validates
    // with its own fetch immediately after, so returning here is safe.
    if (html && !isChallenge(html)) {
      return await getClearanceCookie(page);
    }

    // Empty html means page.content() failed, not that there is no challenge.
    // Fall through: the poll loop keys off the cf-mitigated header and the URL,
    // neither of which needs a readable document, and the budget bounds it.

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
        // Already on the final, token-free URL by definition of cleared() -
        // all that's left is letting that document finish loading.
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

    // Name the state we got stuck in - a bare "did not clear" cost hours of
    // unreadable logs.
    const stuck = widgetSeen
      ? `widget rendered and was clicked ${clicks}x but Cloudflare never let a navigation through`
      : 'no widget ever rendered and the challenge never self-cleared';
    throw new Error(`Cloudflare challenge did not clear after ${SOLVE_BUDGET_MS}ms: ${stuck}.`);
  } finally {
    watch.dispose();
  }
}
