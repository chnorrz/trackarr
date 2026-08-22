import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// No browser mock needed at all here, unlike browser.test.ts: challenge.ts
// only imports child_process and a playwright-core *type*, so it loads
// standalone. Everything below is either a pure string check or a
// solveChallenge() path that bails before it would touch a real page.
const { isBlocked, isChallenge, solveChallenge } = await import(path.join(ROOT, 'dist', 'lib', 'challenge.js'));

// Minimal stand-in for a Playwright Page. solveChallenge attaches a
// 'response' listener (watchChallenge, which reads the cf-mitigated header)
// before it reads content() to decide whether there is anything to solve, so
// the fake needs on/off/mainFrame too.
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
    // Only read when content() throws, to say which page it was.
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
  // Cloudflare serves this script on perfectly good pages too, so matching
  // on 'challenge-platform' is a permanent false positive - see NOTES.md
  // section 5.
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
  // Real content with no challenge markers means someone else already did the
  // work - concurrent cfFetch calls for one host share a page, so the second
  // to reach the solve mutex finds it cleared. Throwing here broke every
  // multi-category browse; the caller re-validates with its own fetch anyway.
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
  // page.content() throws mid-navigation during Cloudflare's redirect chain and
  // safeContent() yields ''. That is "unknown", not "clear" - it must fall
  // through to the poll loop (which keys off the cf-mitigated header and the
  // URL, neither needing a readable document) rather than return a bogus
  // success. With no DISPLAY in the test env that surfaces as the xdotool bail.
  const page = fakePage(async () => {
    throw new Error('Execution context was destroyed');
  });

  await assert.rejects(() => solveChallenge(page), /DISPLAY\/xdotool/);
});

test('an unreadable page whose url() also throws still fails cleanly', async () => {
  // Both calls throw once the page/context is gone. safeContent() reads
  // page.url() from inside its own catch block, so an unguarded call there
  // escapes the helper and breaks the poll loop instead of yielding ''.
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

// The solver used to shell out to xdotool and needed a reachable X display of
// its own, so there was a test here for failing loudly without one. Clicking
// now goes through Camoufox's humanized cursor via page.mouse, which needs
// nothing beyond the page itself, so that failure mode no longer exists.
