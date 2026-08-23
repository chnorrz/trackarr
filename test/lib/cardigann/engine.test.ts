import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { runSearch, runSearchAll } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'engine.js'));
const { validateDefinitionYaml } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'load.js'));

function baseSearchCtx(overrides: Record<string, unknown> = {}) {
  return { keywords: '', categories: [], offset: 0, limit: 50, config: {}, ...overrides };
}

// ---- HTML backend, synthetic minimal definition ----------------------------

function minimalHtmlDefinition(searchOverrides: Record<string, unknown> = {}) {
  return {
    caps: {
      categorymappings: [
        { id: '1', cat: 'Movies', desc: 'Movies' },
        { id: '2', cat: 'TV', desc: 'TV Shows' }
      ]
    },
    search: {
      rows: { selector: 'tr.row' },
      fields: {
        title: { selector: 'a.title' },
        details: { selector: 'a.title', attribute: 'href' },
        download: { selector: 'a.magnet', attribute: 'href' },
        size: { selector: 'td.size' },
        category: { selector: 'td.cat' },
        seeders: { selector: 'td.seeds' },
        leechers: { selector: 'td.leech' },
        date: { selector: 'td.date' }
      },
      ...searchOverrides
    }
  };
}

const HTML_BODY = `
<table><tbody>
  <tr class="row">
    <td><a class="title" href="/t/1">Ubuntu 24.04 Desktop</a></td>
    <td class="cat">1</td>
    <td class="size">1.5 GB</td>
    <td class="seeds">50</td>
    <td class="leech">3</td>
    <td class="date">2024-01-15T10:00:00Z</td>
    <td><a class="magnet" href="magnet:?xt=urn:btih:ABCDEF1234567890&dn=Ubuntu">m</a></td>
  </tr>
  <tr class="row">
    <td><a class="title" href="/t/2">Some TV Show S01E01</a></td>
    <td class="cat">2</td>
    <td class="size">700 MB</td>
    <td class="seeds">10</td>
    <td class="leech">1</td>
    <td class="date">2024-01-16T10:00:00Z</td>
    <td><a class="magnet" href="magnet:?xt=urn:btih:1234567890ABCDEF&dn=TVShow">m</a></td>
  </tr>
</tbody></table>
`;

test('runSearch (HTML): full pipeline - rows, fields, size parsing, category mapping, magnet capture', () => {
  const items = runSearch(minimalHtmlDefinition(), HTML_BODY, baseSearchCtx());
  assert.equal(items.length, 2);

  const first = items[0];
  assert.equal(first.title, 'Ubuntu 24.04 Desktop');
  assert.equal(first.detailUrl, '/t/1');
  assert.equal(first.size, Math.round(1.5 * 1024 ** 3));
  assert.equal(first.category, 'Movies');
  assert.equal(first.seeds, 50);
  assert.equal(first.leechers, 3);
  // The definition's field is named "download" (even though its value is a
  // magnet: URI) - it lands in item.download, not item.magnet, which is
  // only populated by a field actually named "magnet".
  assert.equal(first.download, 'magnet:?xt=urn:btih:ABCDEF1234567890&dn=Ubuntu');
  assert.equal(first.pubDate.toISOString(), '2024-01-15T10:00:00.000Z');
});

test('runSearch (HTML): category falls back to Other when the tracker id has no mapping', () => {
  const body = HTML_BODY.replace('<td class="cat">1</td>', '<td class="cat">999</td>');
  const items = runSearch(minimalHtmlDefinition(), body, baseSearchCtx());
  assert.equal(items[0].category, 'Other');
});

test('runSearch (HTML): offset/limit slices the final item list', () => {
  const items = runSearch(minimalHtmlDefinition(), HTML_BODY, baseSearchCtx({ offset: 1, limit: 1 }));
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Some TV Show S01E01');
});

test('runSearch (HTML): search.rows.filters andmatch excludes rows not matching every keyword', () => {
  const def = minimalHtmlDefinition({ rows: { selector: 'tr.row', filters: [{ name: 'andmatch' }] } });
  const items = runSearch(def, HTML_BODY, baseSearchCtx({ keywords: 'ubuntu 24.04' }));
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Ubuntu 24.04 Desktop');
});

test('runSearch (HTML): .Result chaining - a later field can reference an earlier field\'s already-extracted value', () => {
  const def = minimalHtmlDefinition();
  (def.search.fields as Record<string, unknown>).title = { selector: 'a.title' };
  (def.search.fields as Record<string, unknown>).description = { text: 'Category was: {{ .Result.category }}' };
  const items = runSearch(def, HTML_BODY, baseSearchCtx());
  // .Result.category is the field's own raw extracted value ("1") - category
  // NAME mapping (caps.categorymappings) happens once, after every field has
  // been extracted, and is never written back into .Result for other fields
  // to see. This matches real Cardigann: mapping is the consuming
  // application's concern, not something the template/filter system exposes.
  assert.equal(items[0].description, 'Category was: 1');
});

test('runSearch (HTML): a filter with a templated arg is rendered against .Result before being applied (the YTS pattern)', () => {
  const def = minimalHtmlDefinition();
  // Fields must be declared in this order - JS object key order is
  // extraction order, and _year has to be extracted before title's filter
  // can reference {{ .Result._year }}. Rebuilding the whole fields object
  // (rather than assigning def.search.fields._year onto the existing one)
  // is deliberate: assigning a new key to an existing object always appends
  // it at the end regardless of where you write the assignment in source,
  // which would put _year AFTER title and silently break this exact test.
  (def.search as { fields: unknown }).fields = {
    _year: { text: '2020' },
    title: { selector: 'a.title', filters: [{ name: 'append', args: '.{{ .Result._year }}' }] }
  };
  const items = runSearch(def, HTML_BODY, baseSearchCtx());
  assert.equal(items[0].title, 'Ubuntu 24.04 Desktop.2020');
});

test('runSearch (HTML): case block resolves downloadvolumefactor-style fields, skipping the filter chain', () => {
  const def = minimalHtmlDefinition();
  (def.search.fields as Record<string, unknown>).downloadvolumefactor = {
    case: { 'a.magnet': '0', '*': '1' }
  };
  const items = runSearch(def, HTML_BODY, baseSearchCtx());
  // Every row here has a.magnet, so both should resolve to "0" via case,
  // captured only as ctx.Result - runSearch doesn't surface arbitrary fields
  // beyond the known CardigannItem shape, so assert indirectly via a
  // description field referencing it.
  (def.search.fields as Record<string, unknown>).description = { text: 'dlvf={{ .Result.downloadvolumefactor }}' };
  const items2 = runSearch(def, HTML_BODY, baseSearchCtx());
  assert.equal(items2[0].description, 'dlvf=0');
  void items;
});

test('runSearch (HTML): optional + default supplies a value when the selector does not match', () => {
  const def = minimalHtmlDefinition();
  (def.search.fields as Record<string, unknown>).poster = { selector: 'img.nonexistent', optional: true, default: 'no-poster' };
  const items = runSearch(def, HTML_BODY, baseSearchCtx());
  assert.equal(items[0].poster, 'no-poster');
});

test('runSearch (HTML): a field with no match and no default resolves to empty, not an error', () => {
  const def = minimalHtmlDefinition();
  const items = runSearch(def, HTML_BODY, baseSearchCtx());
  assert.equal(items[0].imdbid, undefined);
});

test('runSearch (HTML): an unparseable date field falls back to "now", not a crash', () => {
  const body = HTML_BODY.replace('2024-01-15T10:00:00Z', 'not-a-real-date');
  const items = runSearch(minimalHtmlDefinition(), body, baseSearchCtx());
  const delta = Math.abs(items[0].pubDate.getTime() - Date.now());
  assert.ok(delta < 5000, 'pubDate should fall back to approximately now');
});

test('runSearch (HTML): a row that fails to match at all is simply excluded, not fatal for the rest', () => {
  const items = runSearch(minimalHtmlDefinition(), '<table><tbody></tbody></table>', baseSearchCtx());
  assert.deepEqual(items, []);
});

// ---- JSON backend, synthetic minimal definition -----------------------------

function minimalJsonDefinition() {
  return {
    caps: {
      categorymappings: [{ id: '201', cat: 'Movies', desc: 'Movies' }]
    },
    search: {
      response: { type: 'json' as const },
      rows: { selector: '$' },
      fields: {
        _id: { selector: 'id' },
        title: { selector: 'name' },
        details: { text: 'https://example.test/browse/{{ .Result._id }}' },
        category: { selector: 'category' },
        size: { selector: 'size' },
        seeders: { selector: 'seeders' },
        leechers: { selector: 'leechers' },
        infohash: { selector: 'info_hash' },
        downloadvolumefactor: { selector: 'freeleech', case: { '0': '1', '1': '0' } }
      }
    }
  };
}

const JSON_BODY = JSON.stringify([
  { id: '42', name: 'Some Linux ISO', category: '201', size: 1610612736, seeders: 88, leechers: 4, info_hash: 'A1B2C3', freeleech: 0 },
  { id: '43', name: 'Another Release', category: '999', size: 512, seeders: 1, leechers: 0, info_hash: 'DEADBEEF', freeleech: 1 }
]);

test('runSearch (JSON): full pipeline - $-rooted rows, numeric category mapping, templated details from .Result._id', () => {
  const items = runSearch(minimalJsonDefinition(), JSON_BODY, baseSearchCtx());
  assert.equal(items.length, 2);

  const first = items[0];
  assert.equal(first.title, 'Some Linux ISO');
  assert.equal(first.detailUrl, 'https://example.test/browse/42');
  assert.equal(first.category, 'Movies');
  assert.equal(first.size, 1610612736);
  assert.equal(first.seeds, 88);
  assert.equal(first.infohash, 'A1B2C3');

  assert.equal(items[1].category, 'Other'); // 999 has no mapping
});

test('runSearch (JSON): case-block downloadvolumefactor resolves by value equality against a sibling field', () => {
  const def = minimalJsonDefinition();
  (def.search.fields as Record<string, unknown>).description = { text: 'dlvf={{ .Result.downloadvolumefactor }}' };
  const items = runSearch(def, JSON_BODY, baseSearchCtx());
  assert.equal(items[0].description, 'dlvf=1'); // freeleech:0 -> case "0" -> "1"
  assert.equal(items[1].description, 'dlvf=0'); // freeleech:1 -> case "1" -> "0"
});

test('runSearch (JSON): count.selector resolving falsy short-circuits to zero results', () => {
  const def = minimalJsonDefinition();
  (def.search.rows as { count?: unknown }).count = { selector: '$[0].id' };
  const items = runSearch(def, '[]', baseSearchCtx());
  assert.deepEqual(items, []);
});

// ---- End-to-end against the real, checked-in kickasstorrents-to.yml ---------

test('runSearch: end to end against the real definitions/kickasstorrents-to.yml (mechanics, not live-site fidelity)', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'definitions', 'kickasstorrents-to.yml'), 'utf8');
  const result = validateDefinitionYaml(raw);
  assert.equal(result.ok, true, JSON.stringify(result.ok === false ? result.errors : null));

  // Synthetic HTML built to match the real definition's own selectors
  // (table.data > tbody > tr:has(a[href^="magnet:?xt="]), a.cellMainLink,
  // span > strong, td.timeago, td:nth-child(N)) - this proves the ENGINE
  // correctly executes a real definition's selector/filter syntax. It does
  // NOT prove kickass.torrentbay.st's actual live markup matches these
  // selectors - that's phase 4's live test, against real captured HTML.
  const body = `
    <table class="data"><tbody>
      <tr>
        <td>
          <span><strong>&gt;Movies</strong></span>
          <a class="cellMainLink" href="/torrent/123-ubuntu">Ubuntu 24.04 LTS Desktop</a>
          <a href="magnet:?xt=urn:btih:ABCDEF1234567890&amp;dn=Ubuntu">magnet</a>
        </td>
        <td>1.5 GB</td>
        <td>3 files</td>
        <td class="timeago">2 hours and 1 day</td>
        <td>50</td>
        <td>5</td>
      </tr>
    </tbody></table>
  `;

  const items = runSearch(result.definition, body, baseSearchCtx({ keywords: 'ubuntu' }));
  assert.equal(items.length, 1);

  const item = items[0];
  assert.equal(item.title, 'Ubuntu 24.04 LTS Desktop');
  assert.equal(item.detailUrl, '/torrent/123-ubuntu');
  // kickass's own field is named "download" (see line 154-156 of the real
  // file), even though it selects a magnet: URI - it lands in
  // item.download, not item.magnet.
  assert.equal(item.download, 'magnet:?xt=urn:btih:ABCDEF1234567890&dn=Ubuntu');
  assert.equal(item.size, Math.round(1.5 * 1024 ** 3));
  assert.equal(item.seeds, 50);
  assert.equal(item.leechers, 5);
  assert.equal(item.category, 'Movies'); // via id "Movies" -> cat "Movies" (line 86 of the real file)
  // timeago filter parsed "2 hours and 1 day" relative to real "now" -
  // assert it landed roughly 26h in the past, not an exact instant.
  const deltaMs = Date.now() - item.pubDate.getTime();
  assert.ok(deltaMs > 25.5 * 3600 * 1000 && deltaMs < 26.5 * 3600 * 1000, `expected ~26h ago, got ${deltaMs}ms`);
});

// ---- preprocessingfilters / runSearchAll ------------------------------------

test('search.preprocessingfilters run on the raw body before row parsing', () => {
  // A bare <tr> soup with no wrapping <table> - HTML5 parsing rules would
  // foster-parent (drop) it. prepend/append wrap it in a real table first,
  // proving preprocessingfilters actually ran before selectDomRows().
  const bareRows = `
    <tr class="row"><td><a class="title" href="/t/1">Bare Row</a></td><td class="cat">1</td>
      <td class="size">1 GB</td><td class="seeds">5</td><td class="leech">1</td><td class="date">2024-01-01</td>
      <td><a class="magnet" href="magnet:?xt=urn:btih:AAA">m</a></td></tr>`;
  const definition = minimalHtmlDefinition({
    preprocessingfilters: [
      { name: 'prepend', args: '<table><tbody>' },
      { name: 'append', args: '</tbody></table>' }
    ]
  });

  const items = runSearch(definition, bareRows, baseSearchCtx());
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Bare Row');
});

test('runSearch (HTML): caps.categories object form is also read, not just categorymappings array form', () => {
  const definition = {
    caps: { categories: { '1': 'Movies', '2': 'TV' } },
    search: minimalHtmlDefinition().search
  };
  const items = runSearch(definition, HTML_BODY, baseSearchCtx());
  assert.equal(items[0].category, 'Movies');
  assert.equal(items[1].category, 'TV');
});

test('runSearchAll returns every item unsliced; runSearch slices to offset/limit on top of the same list', () => {
  const definition = minimalHtmlDefinition();
  const all = runSearchAll(definition, HTML_BODY, baseSearchCtx({ offset: 0, limit: 1 }));
  assert.equal(all.length, 2, 'runSearchAll ignores offset/limit entirely');

  const sliced = runSearch(definition, HTML_BODY, baseSearchCtx({ offset: 0, limit: 1 }));
  assert.equal(sliced.length, 1);
  assert.equal(sliced[0].title, all[0].title);
});
