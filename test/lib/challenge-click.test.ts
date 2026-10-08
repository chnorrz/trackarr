import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// Every call to the page and to xdotool, in order, so the test can check what
// happened before each click.
const events: string[] = [];

mock.module('child_process', {
  exports: {
    execFileSync: () => Buffer.from('1280 900'),
    spawn: () => ({
      exitCode: null,
      killed: false,
      stdin: {
        writable: true,
        write: (line: string) => {
          events.push(`xdo:${line.trim()}`);
          return true;
        }
      },
      on: () => {},
      unref: () => {}
    })
  }
});

process.env.DISPLAY = ':99';

const { solveChallenge } = await import(path.join(ROOT, 'dist', 'lib', 'challenge.js'));

function challengePage(opts: { bringToFrontFails?: boolean } = {}) {
  let onResponse: ((res: unknown) => void) | null = null;
  let currentUrl = 'https://example.test/?__cf_chl_rt_tk=x';
  const mainFrame = {};
  const box = { x: 10, y: 20, width: 300, height: 65 };

  const page = {
    on: (_event: string, fn: (res: unknown) => void) => {
      onResponse = fn;
    },
    off: () => {
      onResponse = null;
    },
    mainFrame: () => mainFrame,
    url: () => currentUrl,
    content: async () => '<div class="cf-turnstile"></div>',
    evaluate: async () => ({ x: 0, y: 80 }),
    waitForLoadState: async () => {},
    context: () => ({ cookies: async () => [{ name: 'cf_clearance', value: 'solved' }] }),
    bringToFront: async () => {
      events.push('bringToFront');
      if (opts.bringToFrontFails) throw new Error('window gone');
    },
    locator: () => ({
      count: async () => 1,
      first: () => ({ boundingBox: async () => box })
    }),
    clear: () => {
      currentUrl = 'https://example.test/';
      onResponse?.({
        frame: () => mainFrame,
        request: () => ({ isNavigationRequest: () => true }),
        headers: () => ({})
      });
    }
  };
  return page;
}

// True when every click has its own `by` event since the previous click.
function clicksPreceded(by: string): boolean {
  let seen = false;
  for (const e of events) {
    if (e === by) seen = true;
    if (e === 'xdo:click 1') {
      if (!seen) return false;
      seen = false;
    }
  }
  return true;
}

test('solveChallenge raises the page window before every click', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  events.length = 0;
  const page = challengePage();

  const solving = solveChallenge(page);
  // Two click cycles (4s cooldown), then let Cloudflare clear.
  for (let i = 0; i < 40 && events.filter((e) => e === 'xdo:click 1').length < 2; i++) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(250);
  }
  page.clear();
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(250);
  }

  assert.equal(await solving, 'solved');
  assert.equal(events.filter((e) => e === 'xdo:click 1').length, 2);
  assert.ok(
    clicksPreceded('bringToFront'),
    `each click must follow its own bringToFront, otherwise it hits whatever window is on top: ${events.join(', ')}`
  );
});

test('a failing bringToFront does not stop the click', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  events.length = 0;
  const page = challengePage({ bringToFrontFails: true });

  const solving = solveChallenge(page);
  for (let i = 0; i < 20 && !events.includes('xdo:click 1'); i++) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(250);
  }
  page.clear();
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(250);
  }

  assert.equal(await solving, 'solved');
  assert.ok(events.includes('xdo:click 1'));
});
