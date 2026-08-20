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

// Minimal stand-in for a Playwright Page - solveChallenge only calls
// waitForLoadState() and content() before deciding whether there is
// anything to solve.
function fakePage(content: () => Promise<string>) {
  return {
    waitForLoadState: async () => {},
    content
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

test('solveChallenge refuses a page that shows no solvable challenge', async () => {
  const page = fakePage(async () => '<html><body>a hard block, or just an unrelated failure</body></html>');

  await assert.rejects(
    () => solveChallenge(page, 'https://example.test/search'),
    /no solvable challenge/,
    'a page with no Turnstile widget is not something clicking can fix - it must fail loudly rather than sit in the poll loop until the budget runs out'
  );
});

test('solveChallenge treats an unreadable page as nothing to solve', async () => {
  // page.content() throws mid-navigation during Cloudflare's redirect chain;
  // safeContent() swallows that and yields '', which must not be mistaken
  // for a challenge.
  const page = fakePage(async () => {
    throw new Error('Execution context was destroyed');
  });

  await assert.rejects(() => solveChallenge(page, 'https://example.test/search'), /htmlLen=0/);
});

test('solveChallenge fails clearly when there is no DISPLAY to click on', async () => {
  const saved = process.env.DISPLAY;
  delete process.env.DISPLAY;

  try {
    const page = fakePage(async () => '<div class="cf-turnstile"></div>');

    await assert.rejects(
      () => solveChallenge(page, 'https://example.test/search'),
      /DISPLAY/,
      'without an X display the solver cannot inject input at all, and should say so instead of failing as a generic timeout'
    );
  } finally {
    if (saved === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = saved;
  }
});
