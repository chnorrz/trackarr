import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { selectDomRows, selectJsonRows, resolveJsonPath } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'select.js'));

// ---- HTML backend ----------------------------------------------------------

const HTML_BODY = `
<table>
  <tr class="row"><td><a href="/t/1" class="title">Ubuntu 24.04</a></td><td class="size">1.5 GB</td><td><span class="fl">FREE</span></td></tr>
  <tr class="row"><td><a href="/t/2" class="title">Debian 12</a></td><td class="size">2.1 GB</td><td></td></tr>
</table>
`;

test('selectDomRows: rows.selector finds each row, field selectors are scoped to it', () => {
  const rows = selectDomRows(HTML_BODY, 'tr.row', false);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].extract({ selector: 'a.title' }).raw, 'Ubuntu 24.04');
  assert.equal(rows[1].extract({ selector: 'a.title' }).raw, 'Debian 12');
});

test('selectDomRows: attribute extraction reads an HTML attribute instead of text', () => {
  const rows = selectDomRows(HTML_BODY, 'tr.row', false);
  assert.equal(rows[0].extract({ selector: 'a.title', attribute: 'href' }).raw, '/t/1');
});

test('selectDomRows: a non-matching selector reports matched:false, not an empty-but-matched result', () => {
  const rows = selectDomRows(HTML_BODY, 'tr.row', false);
  const result = rows[0].extract({ selector: '.nonexistent' });
  assert.equal(result.matched, false);
  assert.equal(result.raw, '');
});

test('selectDomRows: text: is a fixed literal, bypassing the selector entirely', () => {
  const rows = selectDomRows(HTML_BODY, 'tr.row', false);
  assert.deepEqual(rows[0].extract({ text: 'fixed-value' }), { raw: 'fixed-value', matched: true });
});

test('selectDomRows: case block (HTML) - keys are selectors tested against the row, first match wins', () => {
  const rows = selectDomRows(HTML_BODY, 'tr.row', false);
  const spec = { case: { 'span.fl': '0', '*': '1' } };
  assert.equal(rows[0].extract(spec).raw, '0'); // has span.fl
  assert.equal(rows[1].extract(spec).raw, '1'); // falls through to "*"
});

test('selectDomRows: remove is a lasting mutation seen by later fields on the same row', () => {
  // A bare <tr> outside <table> is foster-parented (dropped) by HTML5
  // parsing rules - needs real table structure to survive cheerio's parse.
  const body = '<table><tbody><tr><td><a href="/x">Title <img src="noise.gif"></a></td></tr></tbody></table>';
  const rows = selectDomRows(body, 'tr', false);
  const row = rows[0];
  // First field removes the <img>, mutating the row...
  const description = row.extract({ selector: 'a', remove: 'img' });
  assert.equal(description.raw, 'Title');
  // ...a LATER field on the same row sees the img already gone.
  const laterImgCheck = row.extract({ selector: 'img' });
  assert.equal(laterImgCheck.matched, false);
});

test('selectDomRows: xmlMode true parses case-sensitive XML tags', () => {
  const xml = '<Items><Item><Title>Foo</Title></Item></Items>';
  const rows = selectDomRows(xml, 'Item', true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extract({ selector: 'Title' }).raw, 'Foo');
});

test('selectDomRows: :has()/:contains()/:not() row selectors work natively via cheerio', () => {
  const rows = selectDomRows(HTML_BODY, 'tr.row:has(span.fl)', false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extract({ selector: 'a.title' }).raw, 'Ubuntu 24.04');
});

// ---- JSON backend -----------------------------------------------------------

const TPB_STYLE_JSON = JSON.stringify([
  { id: '1', name: 'Ubuntu 24.04', size: '1500000000', seeders: 50, username: 'alice' },
  { id: '2', name: 'Debian 12', size: '2100000000', seeders: 10, username: 'bob' }
]);

test('selectJsonRows: a bare "$" selector treats the root array itself as the rows', () => {
  const { rows } = selectJsonRows(TPB_STYLE_JSON, { selector: '$' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].extract({ selector: 'name' }).raw, 'Ubuntu 24.04');
});

test('selectJsonRows: a dot-path selector navigates into a nested array', () => {
  const nested = JSON.stringify({ data: { movies: [{ title: 'A' }, { title: 'B' }] } });
  const { rows } = selectJsonRows(nested, { selector: 'data.movies' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].extract({ selector: 'title' }).raw, 'A');
});

test('selectJsonRows: $[N] numeric indexing (thepiratebay.yml\'s own count.selector shape)', () => {
  assert.equal(resolveJsonPath(JSON.parse(TPB_STYLE_JSON), '$[0].id'), '1');
  assert.equal(resolveJsonPath(JSON.parse('[]'), '$[0].id'), undefined);
});

test('selectJsonRows: count.selector resolving falsy is an explicit "no results", distinct from a merely-empty selector', () => {
  const result = selectJsonRows('[]', { selector: '$', count: { selector: '$[0].id' } });
  assert.equal(result.explicitNoResults, true);
  assert.equal(result.rows.length, 0);
});

test('selectJsonRows: count.selector resolving truthy proceeds to normal row selection', () => {
  const result = selectJsonRows(TPB_STYLE_JSON, { selector: '$', count: { selector: '$[0].id' } });
  assert.equal(result.explicitNoResults, false);
  assert.equal(result.rows.length, 2);
});

test('selectJsonRows: :has(subpath) filters array items by existence of a nested value (wiki\'s own row-selector syntax)', () => {
  const data = JSON.stringify([{ name: 'A', size: 100 }, { name: 'B' }]);
  const { rows } = selectJsonRows(data, { selector: '$:has(size)' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extract({ selector: 'name' }).raw, 'A');
});

test('selectJsonRows: :has(subpath:contains(text)) - TPB\'s own uploader filter shape', () => {
  const { rows } = selectJsonRows(TPB_STYLE_JSON, { selector: '$:has(username:contains(ali))' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extract({ selector: 'name' }).raw, 'Ubuntu 24.04');
});

test('selectJsonRows: :not(subpath:contains(text)) - the wiki\'s own exclusion example shape', () => {
  const { rows } = selectJsonRows(TPB_STYLE_JSON, { selector: '$:not(username:contains(ali))' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extract({ selector: 'name' }).raw, 'Debian 12');
});

test('selectJsonRows: nested :has(:has(...)) / :has(:not(...)) compose correctly, not just one level deep', () => {
  const data = JSON.stringify([
    { name: 'A', tags: { x: 1 } },
    { name: 'B', tags: {} }
  ]);
  const { rows } = selectJsonRows(data, { selector: '$:has(tags:has(x))' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extract({ selector: 'name' }).raw, 'A');
});

test('selectJsonRows: rows.attribute flattens a nested per-row list into individual rows', () => {
  const data = JSON.stringify({
    movies: [
      { title: 'Movie A', year: 2020, torrents: [{ quality: '720p' }, { quality: '1080p' }] },
      { title: 'Movie B', year: 2021, torrents: [{ quality: '480p' }] }
    ]
  });
  const { rows } = selectJsonRows(data, { selector: 'movies', attribute: 'torrents' });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].extract({ selector: 'quality' }).raw, '720p');
  assert.equal(rows[2].extract({ selector: 'quality' }).raw, '480p');
});

test('selectJsonRows: a ".." prefix on a field selector reaches the outer row, not the attribute subset', () => {
  const data = JSON.stringify({
    movies: [{ title: 'Movie A', year: 2020, torrents: [{ quality: '720p' }] }]
  });
  const { rows } = selectJsonRows(data, { selector: 'movies', attribute: 'torrents' });
  assert.equal(rows[0].extract({ selector: 'quality' }).raw, '720p'); // inner (attribute subset)
  assert.equal(rows[0].extract({ selector: '..year' }).raw, '2020'); // outer
  assert.equal(rows[0].extract({ selector: '..title' }).raw, 'Movie A');
});

test('selectJsonRows: a row missing the named attribute is skipped, not fatal', () => {
  const data = JSON.stringify({ movies: [{ title: 'No Torrents Here' }, { title: 'Has Some', torrents: [{ quality: '1080p' }] }] });
  const { rows } = selectJsonRows(data, { selector: 'movies', attribute: 'torrents' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extract({ selector: '..title' }).raw, 'Has Some');
});

test('selectJsonRows: case block (JSON) compares by value equality against a sibling selector, not as a selector itself', () => {
  const data = JSON.stringify([{ freeleech: 0 }, { freeleech: 1 }, { freeleech: 5 }]);
  const { rows } = selectJsonRows(data, { selector: '$' });
  const spec = { selector: 'freeleech', case: { '0': '1', '1': '0' } };
  assert.equal(rows[0].extract(spec).raw, '1'); // freeleech:0 -> case "0" -> "1"
  assert.equal(rows[1].extract(spec).raw, '0'); // freeleech:1 -> case "1" -> "0"
  assert.equal(rows[2].extract(spec).matched, false); // "5" not in case map, no wildcard
});

test('selectJsonRows: a non-array selector result is treated as a single row, not an error', () => {
  const data = JSON.stringify({ single: { title: 'Only One' } });
  const { rows } = selectJsonRows(data, { selector: 'single' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extract({ selector: 'title' }).raw, 'Only One');
});

test('selectJsonRows: an attribute value that is itself a single object (not an array) is treated as one item', () => {
  const data = JSON.stringify({ movies: [{ title: 'A', torrent: { quality: '720p' } }] });
  const { rows } = selectJsonRows(data, { selector: 'movies', attribute: 'torrent' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extract({ selector: 'quality' }).raw, '720p');
});

test('resolveJsonPath: a numeric field value is stringified for a text-selector context, not left as a number type', () => {
  // Exercised indirectly through JsonRow.extract - a numeric raw value must
  // become a comparable string so case blocks and filters (which are all
  // string-based) work on it.
  const { rows } = selectJsonRows(JSON.stringify([{ seeders: 42 }]), { selector: '$' });
  assert.equal(rows[0].extract({ selector: 'seeders' }).raw, '42');
});
