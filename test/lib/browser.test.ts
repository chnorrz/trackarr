import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// Fake Playwright Page - only isClosed()/evaluate()/url() are exercised by
// cfFetch()'s fast path (tryFetch), which is all this test needs: a
// non-challenge response short-circuits before lib/challenge.ts would be
// reached at all (that module has its own tests in challenge.test.ts).
// evaluate() returns tryFetch()'s {challenged, content} shape, same as a
// real page.evaluate(fetch(...)) call would. goto() is still called once
// first (the about:blank origin-establishing pre-nav) and must return
// something with a headers() method - cfFetch reads the nav response's
// cf-mitigated header unconditionally, even on this test's happy path
// where the value itself is never used.
// Flipped by the recycling test to make the page fail the way a wedged one
// does in production - see that test for why goto() is the failure point.
let gotoFails = false;
let pageCloses = 0;

// A factory rather than one shared object, because recyclePage() finds the
// page to evict by identity - a single object reused for every hostname
// would be found under all of them at once and hide that.
const createFakePage = () => ({
  isClosed: () => false,
  evaluate: async () => ({ challenged: false, content: '<html><body>cleared, not a challenge</body></html>' }),
  url: () => 'about:blank',
  goto: async () => {
    if (gotoFails) throw new Error('page.goto: Timeout 15000ms exceeded.');
    return { headers: () => ({}), status: () => 200 };
  },
  close: async () => {
    pageCloses++;
  }
});

let newPageCalls = 0;
let newContextCalls = 0;
let camoufoxCalls = 0;

const fakeContext = {
  newPage: async () => {
    newPageCalls++;
    // Widen the race window so two concurrent callers are actually
    // in-flight at the same time, instead of one finishing before the
    // other even starts.
    await new Promise((r) => setTimeout(r, 20));
    return createFakePage();
  },
  cookies: async () => []
};

const fakeBrowser = {
  newContext: async () => {
    newContextCalls++;
    return fakeContext;
  }
};

mock.module('camoufox-js', {
  exports: {
    Camoufox: async () => {
      camoufoxCalls++;
      return fakeBrowser;
    }
  }
});

const { cfFetch } = await import(path.join(ROOT, 'dist', 'lib', 'browser.js'));

test('concurrent cfFetch calls for the same new hostname only create one page', async () => {
  newPageCalls = 0;
  newContextCalls = 0;
  camoufoxCalls = 0;

  // Different paths on the same hostname - different cfFetch
  // cache keys, so both calls actually reach getOrCreatePersistentPage()
  // instead of one being served straight from the response cache.
  const [a, b] = await Promise.all([
    cfFetch('https://race-test.example/one'),
    cfFetch('https://race-test.example/two')
  ]);

  assert.equal(a, '<html><body>cleared, not a challenge</body></html>');
  assert.equal(b, '<html><body>cleared, not a challenge</body></html>');
  assert.equal(newPageCalls, 1, 'two concurrent first callers for the same hostname must share one page, not create two');
  assert.equal(newContextCalls, 1, 'the underlying browser/context must also only be launched once');
  assert.equal(camoufoxCalls, 1);
});

// The bug this guards against: getOrCreatePersistentPage() only recycles a
// page when isClosed() is true, so a page that stopped navigating without
// ever closing was handed back to every later caller. Live-observed as 55
// consecutive 1337x failures over 14 hours against a host that was reachable
// in 47ms the whole time - see NOTES.md section 15.
test('a page that failed is thrown away instead of being handed to the next caller', async () => {
  newPageCalls = 0;
  pageCloses = 0;

  // goto() is the failure point because a fresh page starts at about:blank,
  // so cfFetch's origin-establishing navigation runs first - the same call
  // that timed out in production.
  gotoFails = true;
  await assert.rejects(
    cfFetch('https://wedge-test.example/one'),
    /Timeout 15000ms/,
    'the original failure must still reach the caller'
  );
  assert.equal(newPageCalls, 1);
  assert.equal(pageCloses, 1, 'the failed page must be closed, not left open');

  gotoFails = false;
  const recovered = await cfFetch('https://wedge-test.example/two');

  assert.equal(recovered, '<html><body>cleared, not a challenge</body></html>');
  assert.equal(newPageCalls, 2, 'the next call must build a fresh page, not reuse the failed one');
});
