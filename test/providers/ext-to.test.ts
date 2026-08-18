import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakePage } from '../helpers.ts';
import type { GotoOptions } from '../../lib/browser.ts';
import type { Page } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SEARCH_HTML = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'ext-to-search.html'), 'utf8');
const MAGNET_JSON = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'ext-to-magnet.json'), 'utf8');

// Typed explicitly (see 1337x.test.ts for why) so mock.calls[].arguments
// infers the real (url, opts?) signature instead of a zero-arg one.
const gotoCleared = mock.fn<(url: string, opts?: GotoOptions) => Promise<Page>>(async () => fakePage());
mock.module(path.join(ROOT, 'dist', 'lib', 'browser.js'), {
  exports: { gotoCleared }
});
const { default: provider } = await import(path.join(ROOT, 'dist', 'providers', 'ext-to.js'));

test('ext.to search() parses real row markup into SearchItem[]', async () => {
  gotoCleared.mock.mockImplementation(async () => fakePage({ content: SEARCH_HTML }));

  const { items } = await provider.search('anything', { offset: 0, limit: 50 });

  assert.equal(items.length, 4);

  const [movie, tv, music, app] = items;
  assert.equal(movie.title, 'Example Movie One (2024) 1080p WEBRip x264 FAKEGRP');
  assert.equal(movie.id, 10000001);
  assert.equal(movie.size, 1.5 * 1024 ** 3);
  assert.equal(movie.seeds, 1200);
  assert.equal(movie.leechers, 340);
  assert.equal(movie.category, 2000); // Movies breadcrumb
  // The exact-date title attr must win over the "1 year ago" relative text.
  assert.equal(movie.pubDate.getFullYear(), 2024);

  assert.equal(tv.category, 5000); // TV breadcrumb
  assert.equal(music.category, 3000); // Music breadcrumb
  assert.equal(app.category, 4000); // Apps breadcrumb -> PC
});

test('ext.to search() filters the uploader link out of the category breadcrumb', async () => {
  // .related-posted's uploader link (href starting with "?") comes before
  // the real category link (href starting with "/") - if the [href^="/"]
  // filter regressed, this would pick up "FakeUploader" as the category text
  // instead of "Movies", which matchCategory would then map to Other (8000)
  // rather than Movies (2000).
  gotoCleared.mock.mockImplementation(async () => fakePage({ content: SEARCH_HTML }));
  const { items } = await provider.search('anything', { offset: 0, limit: 50 });
  assert.equal(items[0]?.category, 2000);
});

test('ext.to search() filters real keyword-search results by requested categories', async () => {
  gotoCleared.mock.mockImplementation(async () => fakePage({ content: SEARCH_HTML }));

  const { items, total } = await provider.search('anything', { categories: [2000], offset: 0, limit: 50 });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.category, 2000);
  assert.equal(total, 1); // the fixture page is short, so filtering ran to a proven exact count
});

test('ext.to blank query with no categories uses the general (no cat param) browse listing', async () => {
  gotoCleared.mock.mockImplementation(async () => fakePage({ content: SEARCH_HTML }));

  const { items } = await provider.search('', { offset: 0, limit: 50 });
  assert.equal(items.length, 4);
  const url = gotoCleared.mock.calls[gotoCleared.mock.calls.length - 1]?.arguments[0] as string;
  assert.doesNotMatch(url, /[?&]cat=/);
});

test('ext.to blank query with an unsupported category (e.g. XXX) returns empty', async () => {
  const { items, total } = await provider.search('', { categories: [6000], offset: 0, limit: 50 });
  assert.deepEqual({ items, total }, { items: [], total: 0 });
});

test('ext.to blank query with several categories merges their browse listings', async () => {
  gotoCleared.mock.mockImplementation(async () => fakePage({ content: SEARCH_HTML }));

  const { items } = await provider.search('', { categories: [2000, 5000], offset: 0, limit: 50 });
  // Both category browses hit the same mocked fixture (4 items each) -
  // confirms the merge actually combines multiple sources rather than
  // just picking one.
  assert.equal(items.length, 8);
});

test('ext.to resolveMagnet() computes the HMAC and parses a real magnet response', async () => {
  gotoCleared.mock.mockImplementation(async () =>
    fakePage({
      content: SEARCH_HTML, // carries the fake searchPageToken + csrf-token
      evaluateResult: { status: 200, text: MAGNET_JSON }
    })
  );

  const magnet = await provider.resolveMagnet({ id: 10000001, url: null });
  assert.ok(magnet.startsWith('magnet:?xt=urn:btih:0000000000000000000000000000000000ccc1'));
});

test('ext.to resolveMagnet() throws without an id', async () => {
  await assert.rejects(() => provider.resolveMagnet({ id: null, url: null }), /requires an id/);
});

test('ext.to resolveMagnet() throws when the page has no searchPageToken', async () => {
  gotoCleared.mock.mockImplementation(async () => fakePage({ content: '<html><head></head><body></body></html>' }));
  await assert.rejects(() => provider.resolveMagnet({ id: 1, url: null }), /searchPageToken/);
});

test('ext.to resolveMagnet() throws on a non-JSON response', async () => {
  gotoCleared.mock.mockImplementation(async () =>
    fakePage({ content: SEARCH_HTML, evaluateResult: { status: 200, text: 'not json' } })
  );
  await assert.rejects(() => provider.resolveMagnet({ id: 10000001, url: null }), /Non-JSON response/);
});

test('ext.to resolveMagnet() throws when the API reports failure', async () => {
  gotoCleared.mock.mockImplementation(async () =>
    fakePage({ content: SEARCH_HTML, evaluateResult: { status: 200, text: JSON.stringify({ success: false }) } })
  );
  await assert.rejects(() => provider.resolveMagnet({ id: 10000001, url: null }), /No magnet in response/);
});
