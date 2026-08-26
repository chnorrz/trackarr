import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchOptions } from '../../lib/browser.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SEARCH_HTML = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'ext-to-search.html'), 'utf8');
const MAGNET_JSON = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'ext-to-magnet.json'), 'utf8');

type CfResponse = { text(): Promise<string>; buffer(): Promise<Buffer> };
function toRes(text: string): CfResponse {
  return { text: async () => text, buffer: async () => Buffer.from(text) };
}

const cfFetch = mock.fn<(url: string, opts?: FetchOptions) => Promise<CfResponse>>(async () => toRes(''));
mock.module(path.join(ROOT, 'dist', 'lib', 'browser.js'), {
  exports: { cfFetch }
});
const { default: provider } = await import(path.join(ROOT, 'dist', 'providers', 'ext-to.js'));

test('ext.to search() parses real row markup into SearchItem[]', async () => {
  cfFetch.mock.mockImplementation(async () => toRes(SEARCH_HTML));

  const { items } = await provider.search('anything', { offset: 0, limit: 50 });

  assert.equal(items.length, 4);

  const [movie, tv, music, app] = items;
  assert.equal(movie.title, 'Example Movie One (2024) 1080p WEBRip x264 FAKEGRP');
  assert.equal(movie.id, 10000001);
  assert.equal(movie.size, 1.5 * 1024 ** 3);
  assert.equal(movie.seeds, 1200);
  assert.equal(movie.leechers, 340);
  assert.equal(movie.category, 2000);
  assert.equal(movie.pubDate.getFullYear(), 2024);

  assert.equal(tv.category, 5000);
  assert.equal(music.category, 3000);
  assert.equal(app.category, 4000);
});

test('ext.to search() filters the uploader link out of the category breadcrumb', async () => {
  cfFetch.mock.mockImplementation(async () => toRes(SEARCH_HTML));
  const { items } = await provider.search('anything', { offset: 0, limit: 50 });
  assert.equal(items[0]?.category, 2000);
});

function categoryRowHtml(id: number, topHref: string, topText: string, subHref?: string, subText?: string): string {
  const sub = subHref ? ` - <a href="${subHref}"><strong>${subText}</strong></a>` : '';
  return `<html><body><table class="search-table"><tbody>
    <tr>
      <td class="text-left">
        <a href="/example-${id}/" class="torrent-title-link"><b>Example ${id}</b></a>
        <div class="related-posted">
          Posted by <a href="?source%5B%5D=3">FakeUploader</a>
          in <a href="${topHref}"><strong>${topText}</strong></a>${sub}
        </div>
        <a class="dwn-btn search-magnet-btn" href="javascript:void(0);" data-id="${id}"></a>
      </td>
      <td class="nowrap-td hide-on-mob"><span class="add-block">Size</span><span>150.00 MB</span></td>
      <td class="hide-on-mob"><span class="add-block">Files</span><span>1</span></td>
      <td class="nowrap-td hide-on-mob"><span class="add-block">Age</span><span title="1 January 2024">1 year ago</span></td>
      <td class="hide-on-mob"><span class="add-block">Seeds</span><span class="text-success">10</span></td>
      <td class="hide-on-mob"><span class="add-block">Leechs</span><span class="text-danger">2</span></td>
      <td class="hide-on-mob"><span class="add-block">Source</span></td>
    </tr>
  </tbody></table></body></html>`;
}

test('ext.to search() classifies audiobooks from the subcategory href, not the link text', async () => {
  cfFetch.mock.mockImplementation(async () =>
    toRes(categoryRowHtml(10000005, '/books/', 'Books', '/books/audio-books/', 'Audio books'))
  );
  const { items } = await provider.search('anything', { offset: 0, limit: 50 });
  assert.equal(items[0]?.category, 3030);
});

test('ext.to search() classifies ebooks from the subcategory href, not just top-level "Books"', async () => {
  cfFetch.mock.mockImplementation(async () =>
    toRes(categoryRowHtml(10000006, '/books/', 'Books', '/books/ebooks/', 'Ebooks'))
  );
  const { items } = await provider.search('anything', { offset: 0, limit: 50 });
  assert.equal(items[0]?.category, 7020);
});

test('ext.to search() classifies PC games and "other games" from the subcategory href', async () => {
  cfFetch.mock.mockImplementation(async () =>
    toRes(categoryRowHtml(10000007, '/games/', 'Games', '/games/pc-games/', 'PC Games'))
  );
  const pcGames = await provider.search('anything', { offset: 0, limit: 50 });
  assert.equal(pcGames.items[0]?.category, 4050);

  cfFetch.mock.mockImplementation(async () =>
    toRes(categoryRowHtml(10000008, '/games/', 'Games', '/games/other-games/', 'Other Games'))
  );
  const otherGames = await provider.search('anything', { offset: 0, limit: 50 });
  assert.equal(otherGames.items[0]?.category, 1090);
});

test('ext.to search() classifies Mac and Android apps from the subcategory href', async () => {
  cfFetch.mock.mockImplementation(async () =>
    toRes(categoryRowHtml(10000009, '/applications/', 'Applications', '/applications/mac/', 'Mac'))
  );
  const mac = await provider.search('anything', { offset: 0, limit: 50 });
  assert.equal(mac.items[0]?.category, 4030);

  cfFetch.mock.mockImplementation(async () =>
    toRes(categoryRowHtml(10000010, '/applications/', 'Applications', '/applications/android/', 'Android'))
  );
  const android = await provider.search('anything', { offset: 0, limit: 50 });
  assert.equal(android.items[0]?.category, 4070);
});

test('ext.to search() filters real keyword-search results by requested categories', async () => {
  cfFetch.mock.mockImplementation(async () => toRes(SEARCH_HTML));

  const { items, total } = await provider.search('anything', { categories: [2000], offset: 0, limit: 50 });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.category, 2000);
  assert.equal(total, 1);
});

test('ext.to blank query with no categories uses the general (no cat param) browse listing', async () => {
  cfFetch.mock.mockImplementation(async () => toRes(SEARCH_HTML));

  const { items } = await provider.search('', { offset: 0, limit: 50 });
  assert.equal(items.length, 4);
  const url = cfFetch.mock.calls[cfFetch.mock.calls.length - 1]?.arguments[0] as string;
  assert.doesNotMatch(url, /[?&]cat=/);
  assert.match(url, /[?&]age=4(&|$)/);
});

test('ext.to blank query with an unsupported category (e.g. XXX) returns empty', async () => {
  const { items, total } = await provider.search('', { categories: [6000], offset: 0, limit: 50 });
  assert.deepEqual({ items, total }, { items: [], total: 0 });
});

test('ext.to blank query with several categories merges their browse listings', async () => {
  cfFetch.mock.mockImplementation(async () => toRes(SEARCH_HTML));

  const { items } = await provider.search('', { categories: [2000, 5000], offset: 0, limit: 50 });
  assert.equal(items.length, 8);
});

test('ext.to resolveMagnet() computes the HMAC and parses a real magnet response', async () => {
  cfFetch.mock.mockImplementation(async (_url, opts) =>
    toRes(opts?.method === 'POST' ? MAGNET_JSON : SEARCH_HTML)
  );

  const resolved = await provider.resolveMagnet({ id: 10000001, url: null });
  assert.equal(resolved.kind, 'magnet');
  assert.ok(resolved.magnet.startsWith('magnet:?xt=urn:btih:0000000000000000000000000000000000ccc1'));
});

test('ext.to resolveMagnet() throws without an id', async () => {
  await assert.rejects(() => provider.resolveMagnet({ id: null, url: null }), /requires an id/);
});

test('ext.to resolveMagnet() throws when the page has no searchPageToken', async () => {
  cfFetch.mock.mockImplementation(async () => toRes('<html><head></head><body></body></html>'));
  await assert.rejects(() => provider.resolveMagnet({ id: 1, url: null }), /searchPageToken/);
});

test('ext.to resolveMagnet() throws on a non-JSON response', async () => {
  cfFetch.mock.mockImplementation(async (_url, opts) =>
    toRes(opts?.method === 'POST' ? 'not json' : SEARCH_HTML)
  );
  await assert.rejects(() => provider.resolveMagnet({ id: 10000001, url: null }), /Non-JSON response/);
});

test('ext.to resolveMagnet() throws when the API reports failure', async () => {
  cfFetch.mock.mockImplementation(async (_url, opts) =>
    toRes(opts?.method === 'POST' ? JSON.stringify({ success: false }) : SEARCH_HTML)
  );
  await assert.rejects(() => provider.resolveMagnet({ id: 10000001, url: null }), /No magnet in response/);
});
