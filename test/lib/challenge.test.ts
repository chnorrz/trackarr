import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const { isBlocked, isChallenge, solveChallenge } = await import(path.join(ROOT, 'dist', 'lib', 'challenge.js'));

// solveChallenge attaches a 'response' listener before reading content(), so
// the fake page needs on/off/mainFrame too.
const pageEvents = {
  on: () => {},
  off: () => {},
  mainFrame: () => ({})
};

function fakePage(content: () => Promise<string>) {
  return {
    ...pageEvents,
    waitForLoadState: async () => {},
    content,
    url: () => 'https://example.test/search'
  };
}

test('isChallenge matches both Cloudflare interstitial markers', () => {
  assert.equal(isChallenge('<div class="cf-turnstile"></div>'), true);
  assert.equal(isChallenge('<title>Just a moment...</title>'), true);
  assert.equal(isChallenge('<html><body>real results</body></html>'), false);
  assert.equal(isChallenge(''), false);
});

test('isChallenge ignores the bot-management beacon injected on cleared pages', () => {
  const cleared = '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><body>results</body>';
  assert.equal(isChallenge(cleared), false);
});

test('isBlocked needs both markers, not either one', () => {
  assert.equal(isBlocked('<h1>Access denied</h1><p>Cloudflare Ray ID</p>'), true);
  assert.equal(isBlocked('<h1>Access denied</h1><p>by this site</p>'), false);
  assert.equal(isBlocked('<p>Powered by Cloudflare</p>'), false);
});

test('solveChallenge refuses a hard block - clicking cannot fix an IP ban', async () => {
  const page = fakePage(async () => '<html><body><h1>Access denied</h1><p>Cloudflare Ray ID</p></body></html>');

  await assert.rejects(
    () => solveChallenge(page),
    /hard block/,
    'a ban page has no widget, so it must fail loudly rather than sit in the poll loop until the budget runs out'
  );
});

test('solveChallenge returns instead of throwing when the page is already clear', async () => {
  const page = {
    ...pageEvents,
    waitForLoadState: async () => {},
    content: async () => '<html><body>real listing, no challenge here</body></html>',
    url: () => 'https://example.test/browse',
    context: () => ({ cookies: async () => [{ name: 'cf_clearance', value: 'abc123def456' }] })
  };

  assert.equal(await solveChallenge(page), 'abc123def456');
});

test('an unreadable page is not mistaken for a cleared one', async () => {
  const page = fakePage(async () => {
    throw new Error('Execution context was destroyed');
  });

  await assert.rejects(() => solveChallenge(page), /DISPLAY\/xdotool/);
});

test('an unreadable page whose url() also throws still fails cleanly', async () => {
  const page = {
    ...pageEvents,
    waitForLoadState: async () => {},
    content: async () => {
      throw new Error('Target closed');
    },
    url: () => {
      throw new Error('Target closed');
    }
  };

  await assert.rejects(() => solveChallenge(page), /DISPLAY\/xdotool/);
});
