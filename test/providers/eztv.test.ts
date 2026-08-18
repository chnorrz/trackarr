import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchOptions } from '../../lib/browser.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SEARCH_HTML = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'eztv-search.html'), 'utf8');

// eztv.ts no longer imports gotoCleared at all - searchByKeyword()'s
// wlinks-reveal flow (a priming GET, then a POST) and resolveMagnet()'s
// detail-page fallback (a plain GET) all go through fetchCfProtectedPage().
const fetchCfProtectedPage = mock.fn<(url: string, opts?: FetchOptions) => Promise<string>>(async () => '');
mock.module(path.join(ROOT, 'dist', 'lib', 'browser.js'), {
  exports: { fetchCfProtectedPage }
});
const { default: provider } = await import(path.join(ROOT, 'dist', 'providers', 'eztv.js'));

test('eztv search() parses the wlinks-revealed markup, including inline magnets', async () => {
  fetchCfProtectedPage.mock.mockImplementation(async () => SEARCH_HTML);

  const { items } = await provider.search('anything', { offset: 0, limit: 50 });

  assert.equal(items.length, 3);

  const [first] = items;
  // Title is derived from the title attr with the trailing "(size)" suffix
  // stripped off - NOT the truncated "..." visible anchor text.
  assert.equal(first.title, 'Example.Show.S01E01.720p.WEB.x264-FAKEGRP');
  assert.equal(first.size, Math.round(412.6 * 1024 ** 2));
  assert.equal(first.category, 5000); // EZTV is TV-only, always CATEGORIES.TV
  assert.equal(first.seeds, 0); // search rows never show seed/leech counts
});

test('eztv resolveMagnet() serves from magnetCache after a prior search(), no second fetch', async () => {
  fetchCfProtectedPage.mock.mockImplementation(async () => SEARCH_HTML);
  const { items } = await provider.search('anything', { offset: 0, limit: 50 });
  const detailUrl = items[0]?.detailUrl;
  assert.ok(detailUrl);

  const callsBeforeResolve = fetchCfProtectedPage.mock.callCount();
  const magnet = await provider.resolveMagnet({ id: null, url: detailUrl });

  assert.ok(magnet.startsWith('magnet:?xt=urn:btih:0000000000000000000000000000000000aaa1'));
  // Cache hit - resolveMagnet must not have called fetchCfProtectedPage again.
  assert.equal(fetchCfProtectedPage.mock.callCount(), callsBeforeResolve);
});

test('eztv resolveMagnet() falls back to a detail-page fetch on a cache miss', async () => {
  const detailHtml = '<html><body><a href="magnet:?xt=urn:btih:0000000000000000000000000000000000eee1">m</a></body></html>';
  fetchCfProtectedPage.mock.mockImplementation(async () => detailHtml);

  const magnet = await provider.resolveMagnet({ id: null, url: 'https://eztvx.to/ep/9999999/never-searched/' });
  assert.ok(magnet.startsWith('magnet:?xt=urn:btih:0000000000000000000000000000000000eee1'));
});

test('eztv resolveMagnet() throws without a url', async () => {
  await assert.rejects(() => provider.resolveMagnet({ id: null, url: null }), /requires a url/);
});

test('eztv search() returns empty for a category that excludes TV, without hitting the network', async () => {
  const callsBefore = fetchCfProtectedPage.mock.callCount();

  const blank = await provider.search('', { categories: [2000], offset: 0, limit: 50 }); // Movies only
  assert.deepEqual(blank, { items: [], total: 0 });

  const keyword = await provider.search('anything', { categories: [2000], offset: 0, limit: 50 });
  assert.deepEqual(keyword, { items: [], total: 0 });

  assert.equal(fetchCfProtectedPage.mock.callCount(), callsBefore); // short-circuited before any fetch
});

test('eztv search() still returns results when TV is among several requested categories', async () => {
  fetchCfProtectedPage.mock.mockImplementation(async () => SEARCH_HTML);

  const { items } = await provider.search('anything', { categories: [2000, 5000], offset: 0, limit: 50 });
  assert.equal(items.length, 3);
});

test('eztv search() passes the wlinks-reveal POST body/headers through to fetchCfProtectedPage', async () => {
  fetchCfProtectedPage.mock.mockImplementation(async () => SEARCH_HTML);
  // Distinct query - 'anything' is already cached by earlier tests in this
  // file (keywordSearchCache is a module-level singleton keyed only by q),
  // which would make this a cache hit that never calls fetchCfProtectedPage.
  await provider.search('a-query-not-used-elsewhere-in-this-file', { offset: 0, limit: 50 });

  const lastCall = fetchCfProtectedPage.mock.calls[fetchCfProtectedPage.mock.calls.length - 1];
  assert.equal(lastCall?.arguments[1]?.method, 'POST');
  assert.equal(lastCall?.arguments[1]?.body, 'layout=def_wlinks');
});
