import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchOptions } from '../../lib/browser.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SEARCH_HTML = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', '1337x-search.html'), 'utf8');
const DETAIL_HTML = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', '1337x-detail.html'), 'utf8');

// mock.module() can only be registered once per specifier per test file, so
// this registers a mutable mock up front - individual tests reconfigure its
// behaviour via mockImplementation() rather than re-registering the module
// mock. Typed explicitly against the real signature - without this,
// mock.calls[].arguments infers from the initial zero-arg implementation
// below, not the real one it stands in for.
//
// 1337x.ts no longer imports gotoCleared at all - fetchListingPage()
// (search/browse) and resolveMagnet() both go through cfFetch()
// now, which returns plain HTML text rather than a live Page (neither needs
// one - resolveMagnet is a pure read, no POST like ext.to's).
const cfFetch = mock.fn<(url: string, opts?: FetchOptions) => Promise<string>>(async () => '');
mock.module(path.join(ROOT, 'dist', 'lib', 'browser.js'), {
  exports: { cfFetch }
});
const { default: provider } = await import(path.join(ROOT, 'dist', 'providers', '1337x.js'));

test('1337x search() parses real row markup into SearchItem[]', async () => {
  cfFetch.mock.mockImplementation(async () => SEARCH_HTML);

  const { items } = await provider.search('anything', { offset: 0, limit: 50 });

  assert.equal(items.length, 4);

  const [movie, , tv, music] = items;
  assert.equal(movie.title, 'Example Movie One (2024) [BluRay] [1080p] [FAKEGRP]');
  assert.equal(movie.detailUrl, 'https://1337x.to/torrent/10000001/Example-Movie-One-2024-BluRay-1080p-FAKEGRP/');
  assert.equal(movie.id, null); // 1337x has no per-row id, only the detail URL
  assert.equal(movie.size, 1.5 * 1024 ** 3);
  assert.equal(movie.seeds, 1200);
  assert.equal(movie.leechers, 340);
  assert.equal(movie.category, 2000); // flaticon-hd -> Movies

  assert.equal(tv.category, 5000); // flaticon-tv -> TV, must win over "hd"/"movie" substrings
  assert.equal(music.category, 3000); // flaticon-music -> Audio
});

test('1337x search() skips rows with no href (malformed row)', async () => {
  const html = '<table class="table-list"><tbody><tr><td class="coll-1 name"><a class="icon"><i class="flaticon-hd"></i></a></td></tr></tbody></table>';
  cfFetch.mock.mockImplementation(async () => html);

  const { items } = await provider.search('anything', { offset: 0, limit: 50 });
  assert.deepEqual(items, []);
});

test('1337x search() categorizes an unrecognized sub id as Other, not by icon class', async () => {
  // /sub/99999/ isn't in SUB_ID_CATEGORY - the icon class here (flaticon-hd,
  // normally Movies) must NOT be used as a fallback any more (it drifted
  // live once already - see NOTES.md section 3's "Category drift"), so an
  // unrecognized sub id lands in Other (8000) instead of a guessed category.
  const html = `<table class="table-list"><tbody><tr>
    <td class="coll-1 name"><a href="/sub/99999/0/" class="icon"><i class="flaticon-hd"></i></a><a href="/torrent/1/whatever/">Unrecognized sub id</a></td>
    <td class="coll-2 seeds">1</td>
    <td class="coll-3 leeches">0</td>
    <td class="coll-date">Jan. 1st '24</td>
    <td class="coll-4 size mob-user">1.0 GB<span class="seeds">1</span></td>
    <td class="coll-5 user"><a href="/user/fakeuploader/">fakeuploader</a></td>
  </tr></tbody></table>`;
  cfFetch.mock.mockImplementation(async () => html);

  const { items } = await provider.search('anything', { offset: 0, limit: 50 });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.category, 8000);
});

test('1337x search() filters real keyword-search results by requested categories', async () => {
  cfFetch.mock.mockImplementation(async () => SEARCH_HTML);

  const { items, total } = await provider.search('anything', { categories: [2000], offset: 0, limit: 50 });
  assert.equal(items.length, 2); // fixture has two Movies rows
  assert.ok(items.every((it: { category: number }) => it.category === 2000));
  assert.equal(total, 2);
});

test('1337x blank query with no categories fetches a fixed Movies/TV/Music/Other page-1 snapshot', async () => {
  cfFetch.mock.mockImplementation(async () => SEARCH_HTML);
  cfFetch.mock.resetCalls();

  const { items } = await provider.search('', { offset: 0, limit: 50 });
  assert.equal(items.length, 16); // 4 categories x 4 fixture items each

  const urls = cfFetch.mock.calls.map((c) => c.arguments[0]);
  assert.deepEqual(urls, [
    'https://1337x.to/cat/Movies/1/',
    'https://1337x.to/cat/TV/1/',
    'https://1337x.to/cat/Music/1/',
    'https://1337x.to/cat/Other/1/'
  ]);
});

test('1337x blank query with an unsupported/unknown category returns empty', async () => {
  const { items, total } = await provider.search('', { categories: [999999], offset: 0, limit: 50 });
  assert.deepEqual({ items, total }, { items: [], total: 0 });
});

test('1337x blank query with several categories merges their browse listings', async () => {
  cfFetch.mock.mockImplementation(async () => SEARCH_HTML);

  const { items } = await provider.search('', { categories: [2000, 5000], offset: 0, limit: 50 });
  assert.equal(items.length, 8); // 2 sources x 4 fixture items each
});

test('1337x resolveMagnet() extracts the real magnet href from a detail page', async () => {
  cfFetch.mock.mockImplementation(async () => DETAIL_HTML);

  const magnet = await provider.resolveMagnet({ id: null, url: 'https://1337x.to/torrent/10000001/whatever/' });
  assert.ok(magnet.startsWith('magnet:?xt=urn:btih:0000000000000000000000000000000000bbb1'));
});

test('1337x resolveMagnet() throws without a url', async () => {
  await assert.rejects(() => provider.resolveMagnet({ id: null, url: null }), /requires a url/);
});

test('1337x resolveMagnet() throws when the page has no magnet link', async () => {
  cfFetch.mock.mockImplementation(async () => '<html><body>no magnet here</body></html>');

  await assert.rejects(
    () => provider.resolveMagnet({ id: null, url: 'https://1337x.to/torrent/1/x/' }),
    /Could not find a magnet link/
  );
});
