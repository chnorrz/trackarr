import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

let gotoFails = false;
let pageCloses = 0;

// A factory, not one shared object: recyclePage() evicts by identity, so a
// reused object would be found under every hostname at once.
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

let newPageFails = false;
let browserCloses = 0;
let addCookiesCalls: unknown[] = [];

const fakeContext = {
  newPage: async () => {
    newPageCalls++;
    // Widens the race window so both callers are genuinely in-flight at once.
    await new Promise((r) => setTimeout(r, 20));
    if (newPageFails) throw new Error('newPage: Target closed');
    return createFakePage();
  },
  cookies: async () => [],
  addCookies: async (cookies: unknown) => {
    addCookiesCalls.push(cookies);
  }
};

const fakeBrowser = {
  newContext: async () => {
    newContextCalls++;
    return fakeContext;
  },
  close: async () => {
    browserCloses++;
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

const { cfFetch, closeBrowser, registerDomainCookies } = await import(path.join(ROOT, 'dist', 'lib', 'browser.js'));

test('concurrent cfFetch calls for the same new hostname only create one page', async () => {
  newPageCalls = 0;
  newContextCalls = 0;
  camoufoxCalls = 0;

  // Different paths = different cfFetch cache keys, so both calls reach
  // getOrCreatePersistentPage() instead of one hitting the response cache.
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

test('a page that failed is thrown away instead of being handed to the next caller', async () => {
  newPageCalls = 0;
  pageCloses = 0;

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

test('a session that cannot open a page is torn down, not leaked', async () => {
  camoufoxCalls = 0;
  browserCloses = 0;

  newPageFails = true;
  await assert.rejects(
    cfFetch('https://leak-test.example/one'),
    /Target closed/
  );
  assert.equal(browserCloses, 1, 'the unusable browser must be closed, not orphaned');

  newPageFails = false;
  const recovered = await cfFetch('https://leak-test.example/two');

  assert.equal(recovered, '<html><body>cleared, not a challenge</body></html>');
  assert.equal(camoufoxCalls, 1, 'the next call must launch a fresh browser');
});

test('cookies registered for a domain are re-applied after a session is discarded and relaunched', async () => {
  addCookiesCalls = [];
  // Force a fresh launchSession() call below, rather than reusing whatever
  // context earlier tests already created (which was built with no cookies
  // registered).
  await closeBrowser();

  registerDomainCookies([{ name: 'layout', value: 'def_wlinks', domain: 'cookie-test.example' }]);

  await cfFetch('https://cookie-test.example/one');
  assert.equal(addCookiesCalls.length, 1);
  assert.deepEqual(addCookiesCalls[0], [{ name: 'layout', value: 'def_wlinks', domain: 'cookie-test.example', path: '/' }]);

  // A distinct hostname, so this reaches context.newPage() rather than
  // reusing the still-open persistent page from the call above.
  newPageFails = true;
  await assert.rejects(cfFetch('https://cookie-test-b.example/two'));
  newPageFails = false;

  await cfFetch('https://cookie-test-c.example/three');
  assert.equal(addCookiesCalls.length, 2, 'cookies must be re-applied on the fresh context after the discarded session relaunches');
});
