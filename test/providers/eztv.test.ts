import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchOptions } from '../../lib/browser.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SEARCH_HTML = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'eztv-search.html'), 'utf8');

const cfFetch = mock.fn<(url: string, opts?: FetchOptions) => Promise<string>>(async () => '');
mock.module(path.join(ROOT, 'dist', 'lib', 'browser.js'), {
  exports: { cfFetch }
});
const { default: provider } = await import(path.join(ROOT, 'dist', 'providers', 'eztv.js'));

test('eztv search() parses the wlinks-revealed markup, including inline magnets and seeds', async () => {
  cfFetch.mock.mockImplementation(async () => SEARCH_HTML);

  const { items } = await provider.search('anything', { offset: 0, limit: 50 });

  // 4 rows in the fixture, one has no magnet link and must be skipped.
  assert.equal(items.length, 3);

  const [first, second, third] = items;
  assert.equal(first?.title, 'Example.Show.S01E01.720p.WEB.x264-FAKEGRP');
  assert.equal(first?.size, Math.round(412.6 * 1024 ** 2));
  assert.equal(first?.category, 5000);
  assert.equal(first?.seeds, 29);
  assert.equal(first?.leechers, 0);

  assert.equal(second?.seeds, 88);

  // Fourth fixture row: a non-numeric seeds cell ("-") must fall back to 0
  // rather than being parsed as a number.
  assert.equal(third?.seeds, 0);
});

test('eztv search() skips rows with no magnet link', async () => {
  cfFetch.mock.mockImplementation(async () => SEARCH_HTML);

  const { items } = await provider.search('anything', { offset: 0, limit: 50 });

  assert.ok(!items.some((it: { title: string }) => it.title.startsWith('No.Links.Show')));
});

test('eztv search() throws when every row is filtered out, instead of returning an empty result', async () => {
  const allLinklessHtml = SEARCH_HTML.replace(
    /<a href="magnet:[^"]*" class="magnet"[^>]*>[\s\S]*?<\/tr>/g,
    '</tr>'
  );
  cfFetch.mock.mockImplementation(async () => allLinklessHtml);

  await assert.rejects(
    () => provider.search('a-query-triggering-the-all-skipped-guard', { offset: 0, limit: 50 }),
    /layout=def_wlinks cookie is probably not applying/
  );
});

test('eztv resolveMagnet() serves from magnetCache after a prior search(), no second fetch', async () => {
  cfFetch.mock.mockImplementation(async () => SEARCH_HTML);
  const { items } = await provider.search('anything', { offset: 0, limit: 50 });
  const detailUrl = items[0]?.detailUrl;
  assert.ok(detailUrl);

  const callsBeforeResolve = cfFetch.mock.callCount();
  const magnet = await provider.resolveMagnet({ id: null, url: detailUrl });

  assert.ok(magnet.startsWith('magnet:?xt=urn:btih:0000000000000000000000000000000000aaa1'));
  assert.equal(cfFetch.mock.callCount(), callsBeforeResolve);
});

test('eztv resolveMagnet() falls back to a detail-page fetch on a cache miss', async () => {
  const detailHtml = '<html><body><a href="magnet:?xt=urn:btih:0000000000000000000000000000000000eee1">m</a></body></html>';
  cfFetch.mock.mockImplementation(async () => detailHtml);

  const magnet = await provider.resolveMagnet({ id: null, url: 'https://eztvx.to/ep/9999999/never-searched/' });
  assert.ok(magnet.startsWith('magnet:?xt=urn:btih:0000000000000000000000000000000000eee1'));
});

test('eztv resolveMagnet() throws without a url', async () => {
  await assert.rejects(() => provider.resolveMagnet({ id: null, url: null }), /requires a url/);
});

test('eztv search() returns empty for a category that excludes TV, without hitting the network', async () => {
  const callsBefore = cfFetch.mock.callCount();

  const blank = await provider.search('', { categories: [2000], offset: 0, limit: 50 });
  assert.deepEqual(blank, { items: [], total: 0 });

  const keyword = await provider.search('anything', { categories: [2000], offset: 0, limit: 50 });
  assert.deepEqual(keyword, { items: [], total: 0 });

  assert.equal(cfFetch.mock.callCount(), callsBefore);
});

test('eztv search() still returns results when TV is among several requested categories', async () => {
  cfFetch.mock.mockImplementation(async () => SEARCH_HTML);

  const { items } = await provider.search('anything', { categories: [2000, 5000], offset: 0, limit: 50 });
  assert.equal(items.length, 3);
});

test('eztv search() makes exactly one cfFetch call - magnets are revealed via a cookie, not a priming GET + reveal POST', async () => {
  cfFetch.mock.mockImplementation(async () => SEARCH_HTML);
  // Distinct query: keywordSearchCache is a module-level singleton keyed only
  // by q, so reusing 'anything' here would be a cache hit that skips cfFetch.
  const callsBefore = cfFetch.mock.callCount();
  await provider.search('a-query-not-used-elsewhere-in-this-file', { offset: 0, limit: 50 });

  assert.equal(cfFetch.mock.callCount(), callsBefore + 1);
  const lastCall = cfFetch.mock.calls[cfFetch.mock.calls.length - 1];
  assert.equal(lastCall?.arguments[1], undefined, 'no method/body - a plain GET');
});
