import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { buildPathRequests } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'paths.js'));

function ctx(overrides: Record<string, unknown> = {}) {
  return { Keywords: '', Query: {}, Categories: [], Config: {}, Result: {}, ...overrides };
}

test('a single search.path (no paths[]) builds exactly one GET request', () => {
  const search = { path: 'search/?q={{ .Keywords }}' };
  const reqs = buildPathRequests(search, 'https://example.test/', ctx({ Keywords: 'ubuntu' }));
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].url, 'https://example.test/search/?q=ubuntu');
  assert.equal(reqs[0].method, 'GET');
});

test('kickasstorrents-to.yml\'s own two unconditional paths both fire, neither restricted by category', () => {
  const search = {
    paths: [
      { path: '{{ if .Keywords }}search/?q={{ .Keywords }}{{ else }}17/All/{{ end }}' },
      { path: '{{ if .Keywords }}search/?page=2&q={{ .Keywords }}{{ else }}17/All/?page=2{{ end }}' }
    ]
  };
  const withKeywords = buildPathRequests(search, 'https://kickass.torrentbay.st/', ctx({ Keywords: 'ubuntu' }));
  assert.deepEqual(
    withKeywords.map((r: { url: string }) => r.url),
    ['https://kickass.torrentbay.st/search/?q=ubuntu', 'https://kickass.torrentbay.st/search/?page=2&q=ubuntu']
  );

  const blank = buildPathRequests(search, 'https://kickass.torrentbay.st/', ctx());
  assert.deepEqual(
    blank.map((r: { url: string }) => r.url),
    ['https://kickass.torrentbay.st/17/All/', 'https://kickass.torrentbay.st/17/All/?page=2']
  );
});

test('paths[].categories restricts a path to only fire when a requested category matches', () => {
  const search = {
    paths: [
      { path: 'browse.php', categories: [901, 902] } // porn-only path, wiki's own example shape
    ]
  };
  const matching = buildPathRequests(search, 'https://example.test/', ctx({ Categories: ['901'] }));
  assert.equal(matching.length, 1);

  const nonMatching = buildPathRequests(search, 'https://example.test/', ctx({ Categories: ['201'] }));
  assert.equal(nonMatching.length, 0);

  const blank = buildPathRequests(search, 'https://example.test/', ctx({ Categories: [] }));
  assert.equal(blank.length, 0, 'a category-restricted path is excluded from a blank/no-category search');
});

test('a "!" first entry negates paths[].categories - the wiki\'s own porn-exclusion example', () => {
  const search = { paths: [{ path: 'torrents.php', categories: ['!', 901, 902] }] };

  const porn = buildPathRequests(search, 'https://example.test/', ctx({ Categories: ['901'] }));
  assert.equal(porn.length, 0, 'excluded when a restricted (porn) category was requested');

  const nonPorn = buildPathRequests(search, 'https://example.test/', ctx({ Categories: ['201'] }));
  assert.equal(nonPorn.length, 1, 'included for any other requested category');

  const blank = buildPathRequests(search, 'https://example.test/', ctx({ Categories: [] }));
  assert.equal(blank.length, 1, 'a negated restriction is included for a blank/no-category search too');
});

test('inputs: search-level and path-level merge by default (inheritinputs unset = true)', () => {
  const search = {
    path: 'torrents.php',
    inputs: { scene: 0, searchin: 'title' }
  };
  const reqs = buildPathRequests(search, 'https://example.test/', ctx());
  const url = new URL(reqs[0].url);
  assert.equal(url.searchParams.get('scene'), '0');
  assert.equal(url.searchParams.get('searchin'), 'title');
});

test('inheritinputs:false replaces the search-level inputs entirely for that path', () => {
  const search = {
    inputs: { scene: 0 },
    paths: [{ path: 'torrents.php', inputs: { scene: 1 }, inheritinputs: false }]
  };
  const reqs = buildPathRequests(search, 'https://example.test/', ctx());
  const url = new URL(reqs[0].url);
  assert.equal(url.searchParams.get('scene'), '1');
  assert.equal(url.searchParams.has('searchin'), false);
});

test('POST method sends inputs as a form-encoded body, not a query string', () => {
  const search = { path: 'takelogin.php', paths: [{ path: 'torrents.php', method: 'post', inputs: { scene: 1 } }] };
  const reqs = buildPathRequests(search, 'https://example.test/', ctx());
  assert.equal(reqs[0].method, 'POST');
  assert.equal(reqs[0].body, 'scene=1');
  assert.equal(reqs[0].headers?.['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(new URL(reqs[0].url).search, '');
});

test('the $raw input is appended to the query string unescaped, alongside normal inputs', () => {
  const search = {
    path: 'browse.php',
    // The wiki's own example (verbatim): a trailing "&" inside the loop
    // body, so a stray "&" before the next joined input is expected, real
    // Cardigann output - not something this code needs to clean up.
    inputs: { $raw: '{{ range .Categories }}category[]={{.}}&{{end}}', searchin: 'title' }
  };
  const reqs = buildPathRequests(search, 'https://example.test/', ctx({ Categories: ['101', '201'] }));
  assert.equal(reqs[0].url, 'https://example.test/browse.php?category[]=101&category[]=201&&searchin=title');
});

test('search.headers are rendered as templates and passed through', () => {
  const search = { path: 'ajax.php', headers: { 'x-requested-with': ['XMLHttpRequest'], 'x-key': ['{{ .Config.apikey }}'] } };
  const reqs = buildPathRequests(search, 'https://example.test/', ctx({ Config: { apikey: 'secret123' } }));
  assert.equal(reqs[0].headers?.['x-requested-with'], 'XMLHttpRequest');
  assert.equal(reqs[0].headers?.['x-key'], 'secret123');
});

test('no search.path and no search.paths[]: builds zero requests, not a crash', () => {
  const reqs = buildPathRequests({}, 'https://example.test/', ctx());
  assert.deepEqual(reqs, []);
});
