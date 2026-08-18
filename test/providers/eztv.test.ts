import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakePage } from '../helpers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SEARCH_HTML = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'eztv-search.html'), 'utf8');

const gotoCleared = mock.fn(async () => fakePage());
mock.module(path.join(ROOT, 'dist', 'lib', 'browser.js'), {
  exports: { gotoCleared }
});
const { default: provider } = await import(path.join(ROOT, 'dist', 'providers', 'eztv.js'));

test('eztv search() parses the wlinks-revealed markup, including inline magnets', async () => {
  gotoCleared.mock.mockImplementation(async () =>
    fakePage({ content: 'unused for this path', evaluateResult: { status: 200, text: SEARCH_HTML } })
  );

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

test('eztv resolveMagnet() serves from magnetCache after a prior search(), no second navigation', async () => {
  gotoCleared.mock.mockImplementation(async () =>
    fakePage({ content: 'unused for this path', evaluateResult: { status: 200, text: SEARCH_HTML } })
  );
  const { items } = await provider.search('anything', { offset: 0, limit: 50 });
  const detailUrl = items[0]?.detailUrl;
  assert.ok(detailUrl);

  const callsBeforeResolve = gotoCleared.mock.callCount();
  const magnet = await provider.resolveMagnet({ id: null, url: detailUrl });

  assert.ok(magnet.startsWith('magnet:?xt=urn:btih:0000000000000000000000000000000000aaa1'));
  // Cache hit - resolveMagnet must not have called gotoCleared again.
  assert.equal(gotoCleared.mock.callCount(), callsBeforeResolve);
});

test('eztv resolveMagnet() falls back to a detail-page fetch on a cache miss', async () => {
  const detailHtml = '<html><body><a href="magnet:?xt=urn:btih:0000000000000000000000000000000000eee1">m</a></body></html>';
  gotoCleared.mock.mockImplementation(async () => fakePage({ content: detailHtml }));

  const magnet = await provider.resolveMagnet({ id: null, url: 'https://eztvx.to/ep/9999999/never-searched/' });
  assert.ok(magnet.startsWith('magnet:?xt=urn:btih:0000000000000000000000000000000000eee1'));
});

test('eztv resolveMagnet() throws without a url', async () => {
  await assert.rejects(() => provider.resolveMagnet({ id: null, url: null }), /requires a url/);
});

test('eztv search() returns empty for a category that excludes TV, without hitting the network', async () => {
  const callsBefore = gotoCleared.mock.callCount();

  const blank = await provider.search('', { categories: [2000], offset: 0, limit: 50 }); // Movies only
  assert.deepEqual(blank, { items: [], total: 0 });

  const keyword = await provider.search('anything', { categories: [2000], offset: 0, limit: 50 });
  assert.deepEqual(keyword, { items: [], total: 0 });

  assert.equal(gotoCleared.mock.callCount(), callsBefore); // short-circuited before any fetch/navigation
});

test('eztv search() still returns results when TV is among several requested categories', async () => {
  gotoCleared.mock.mockImplementation(async () =>
    fakePage({ content: 'unused for this path', evaluateResult: { status: 200, text: SEARCH_HTML } })
  );

  const { items } = await provider.search('anything', { categories: [2000, 5000], offset: 0, limit: 50 });
  assert.equal(items.length, 3);
});

test('eztv search() falls back to the plain page when the wlinks reveal POST fails', async () => {
  // status !== 200 -> search() falls back to page.content() instead of the
  // evaluate() result (see the comment in providers/eztv.ts).
  gotoCleared.mock.mockImplementation(async () =>
    fakePage({ content: SEARCH_HTML, evaluateResult: { status: 500, text: 'error' } })
  );

  const { items } = await provider.search('anything', { offset: 0, limit: 50 });
  assert.equal(items.length, 3); // fixture's fallback content still has the rows (magnet-less in reality, but this fixture always embeds them)
});
