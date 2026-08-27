import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { createCardigannProvider } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'adapter.js'));
const { validateDefinitionYaml } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'load.js'));

// Integration test for the real, checked-in definitions/ext-to.yml - our
// own definition (unlike 1337x.yml/eztv.yml, which come from Prowlarr's
// upstream repo via source: and are never edited here), so it's the one
// definition that needs this level of protection: feed it the same
// hand-built fixture (fake titles/ids, real selector structure - not raw
// captured HTML, see NOTES.md section 13) the old hand-written
// providers/ext-to.ts test used, and confirm the engine still extracts it
// correctly end to end, including the signed-AJAX magnet resolution.

const SEARCH_HTML = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'ext-to-search.html'), 'utf8');
const MAGNET_JSON = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'ext-to-magnet.json'), 'utf8');
const EMPTY_PAGE = '<table class="search-table"><tbody></tbody></table>';

type FakeBody = string | { data: Buffer; filename?: string };

function fakeFetch(responses: Record<string, FakeBody>) {
  const calls: { url: string; opts?: { method?: string; headers?: Record<string, string>; body?: string } }[] = [];
  const fn = async (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, opts });
    const body = responses[url];
    if (body === undefined) throw new Error(`fakeFetch: no canned response for ${url}`);
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body.data;
    const filename = typeof body === 'string' ? undefined : body.filename;
    return {
      text: async () => buf.toString('utf-8'),
      buffer: async () => buf,
      filename
    };
  };
  return { fn, calls };
}

const noSleep = async () => {};

function loadExtTo() {
  const raw = fs.readFileSync(path.join(ROOT, 'definitions', 'ext-to.yml'), 'utf8');
  const result = validateDefinitionYaml(raw);
  assert.ok(result.ok, `definitions/ext-to.yml must be schema-valid: ${result.ok ? '' : result.errors.join('; ')}`);
  if (!result.ok) throw new Error('unreachable');
  return result.definition;
}

function makeProvider(fetchFn: ReturnType<typeof fakeFetch>['fn']) {
  return createCardigannProvider(
    { key: 'ext-to', entry: { definition: 'ext-to' }, resolved: { definitionId: 'ext-to', from: 'test', definition: loadExtTo() } },
    { fetch: fetchFn, sleep: noSleep }
  );
}

test('ext-to.yml: search fetches both its unconditional paths and parses real row markup into items', async () => {
  const { fn } = fakeFetch({
    'https://ext.to/browse/?q=anything&page_size=100&page=1': SEARCH_HTML,
    'https://ext.to/browse/?q=anything&page_size=100&page=2': EMPTY_PAGE
  });
  const provider = makeProvider(fn);

  const { items, total } = await provider.search('anything', { offset: 0, limit: 50 });
  assert.equal(total, 4);
  assert.equal(items.length, 4);

  const [movie, tv, music, app] = items;
  assert.equal(movie.title, 'Example Movie One (2024) 1080p WEBRip x264 FAKEGRP');
  assert.equal(movie.size, Math.round(1.5 * 1024 ** 3));
  assert.equal(movie.seeds, 1200);
  assert.equal(movie.leechers, 340);
  assert.equal(movie.category, 2000, 'breadcrumb href /movies/highres-movies/ collapses to /movies/ -> Movies');
  assert.equal(movie.pubDate.getFullYear(), 2024);

  assert.equal(tv.category, 5000, 'breadcrumb href /tv/episodes-hd/ collapses to /tv/ -> TV');
  assert.equal(music.category, 3000, '/music/ -> Audio');
  assert.equal(app.category, 4000, '/applications/ -> PC');
});

test('ext-to.yml: the uploader link in .related-posted is excluded from the category breadcrumb match', async () => {
  const { fn } = fakeFetch({
    'https://ext.to/browse/?q=anything&page_size=100&page=1': SEARCH_HTML,
    'https://ext.to/browse/?q=anything&page_size=100&page=2': EMPTY_PAGE
  });
  const provider = makeProvider(fn);

  const { items } = await provider.search('anything', { offset: 0, limit: 50 });
  // Row 2's own uploader link (/user/fakeverifieduploader/) starts with "/"
  // too - if the :not([href^="/user/"]) selector clause regressed, this
  // would incorrectly become the ":last" match instead of /tv/episodes-hd/.
  assert.equal(items[1]?.category, 5000);
});

test('ext-to.yml: resolveMagnet() replays the signed AJAX request captured at search time and parses a real magnet response', async () => {
  const { fn, calls } = fakeFetch({
    'https://ext.to/browse/?q=anything&page_size=100&page=1': SEARCH_HTML,
    'https://ext.to/browse/?q=anything&page_size=100&page=2': EMPTY_PAGE,
    'https://ext.to/ajax/getSearchMagnet.php': MAGNET_JSON
  });
  const provider = makeProvider(fn);

  const { items } = await provider.search('anything', { offset: 0, limit: 50 });
  const resolved = await provider.resolveMagnet({ id: null, url: items[0]?.detailUrl ?? '' });

  assert.equal(resolved.kind, 'magnet');
  assert.match(resolved.magnet, /^magnet:\?xt=urn:btih:0000000000000000000000000000000000ccc1/);

  const magnetCall = calls.find((c) => c.url === 'https://ext.to/ajax/getSearchMagnet.php');
  assert.equal(magnetCall?.opts?.method, 'POST', 'the API requires POST, not a GET replay');
});
