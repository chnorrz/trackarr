import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// Isolate cookie/UA file reads+writes from the real dev environment - these
// are guarded by try/catch and safe to point at a directory with nothing in
// it, but there's no reason to touch real files for a test.
process.env.DATA_DIR = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'trackarr-browser-test-')));

// Fake Playwright Page - only isClosed()/evaluate()/url() are exercised by
// fetchCfProtectedPage()'s fast path (tryFetch), which is all this test
// needs: a non-challenge response short-circuits before any real
// solve machinery would be touched. goto() is still called once first (the
// about:blank origin-establishing pre-nav) and must exist, even though
// nothing here asserts on it.
const fakePage = {
  isClosed: () => false,
  evaluate: async () => '<html><body>cleared, not a challenge</body></html>',
  url: () => 'about:blank',
  goto: async () => {}
};

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
    return fakePage;
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

const { fetchCfProtectedPage } = await import(path.join(ROOT, 'dist', 'lib', 'browser.js'));

test('concurrent fetchCfProtectedPage calls for the same new hostname only create one page', async () => {
  newPageCalls = 0;
  newContextCalls = 0;
  camoufoxCalls = 0;

  // Different paths on the same hostname - different fetchCfProtectedPage
  // cache keys, so both calls actually reach getOrCreatePersistentPage()
  // instead of one being served straight from the response cache.
  const [a, b] = await Promise.all([
    fetchCfProtectedPage('https://race-test.example/one'),
    fetchCfProtectedPage('https://race-test.example/two')
  ]);

  assert.equal(a, '<html><body>cleared, not a challenge</body></html>');
  assert.equal(b, '<html><body>cleared, not a challenge</body></html>');
  assert.equal(newPageCalls, 1, 'two concurrent first callers for the same hostname must share one page, not create two');
  assert.equal(newContextCalls, 1, 'the underlying browser/context must also only be launched once');
  assert.equal(camoufoxCalls, 1);
});
