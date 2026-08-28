import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { createCardigannProvider } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'adapter.js'));
const { validateDefinitionYaml } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'load.js'));

// A single Fetcher now covers both text pages and raw file selectors (see
// lib/browser.ts's CfResponse) - a canned response can be a plain string
// (the common case) or {data, filename} for a test simulating a resolved
// .torrent file's real bytes/Content-Disposition name.
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

// ---- faketracker.yml (test fixture, not a real site), both its two paths --

const FAKE_TRACKER_YAML = path.join(ROOT, 'test', 'fixtures', 'cardigann', 'faketracker.yml');

// faketracker.yml's size/seeders/leechers are POSITIONAL (td:nth-child(2)/
// (5)/(6)), while category/title/date/download are found by class or
// attribute anywhere in the row - the column layout below satisfies the
// positional ones; the others could live anywhere.
function fakeTrackerRow(id: number, title: string, sizeMb: number, seeds: number, leechers: number, catLabel: string, timeago: string): string {
  return `
    <tr>
      <td><span><strong>${catLabel}</strong></span> <a class="cellMainLink" href="/torrent/${id}">${title}</a></td>
      <td>${sizeMb} MB</td>
      <td class="timeago">${timeago}</td>
      <td>filler</td>
      <td>${seeds}</td>
      <td>${leechers}</td>
      <td><a href="magnet:?xt=urn:btih:${'A'.repeat(39)}${id}&dn=${encodeURIComponent(title)}">m</a></td>
    </tr>`;
}

function fakeTrackerPage(rows: string[]): string {
  return `<table class="data"><tbody>${rows.join('\n')}</tbody></table>`;
}

test('faketracker.yml: search fetches both its real paths and concatenates results', async () => {
  const result = validateDefinitionYaml(fs.readFileSync(FAKE_TRACKER_YAML, 'utf8'));
  assert.ok(result.ok, 'fixture definition must be schema-valid');
  if (!result.ok) return;

  const page1Url = 'https://faketracker.example/search/?q=ubuntu';
  const page2Url = 'https://faketracker.example/search/?page=2&q=ubuntu';
  const { fn, calls } = fakeFetch({
    [page1Url]: fakeTrackerPage([fakeTrackerRow(1, 'Ubuntu 24.04 Desktop', 1500, 50, 5, '>Movies', 'now')]),
    [page2Url]: fakeTrackerPage([fakeTrackerRow(2, 'Ubuntu 24.04 Server', 900, 20, 2, '>Movies', '1 hour')])
  });

  const provider = createCardigannProvider(
    { key: 'faketracker', entry: { definition: 'faketracker' }, resolved: { definitionId: 'faketracker', from: 'test', definition: result.definition } },
    { fetch: fn, sleep: noSleep }
  );

  assert.equal(provider.id, 'faketracker');
  assert.equal(provider.name, 'Fake Tracker (test fixture)');
  assert.equal(provider.keepAlive?.url, 'https://faketracker.example/');

  const { items, total } = await provider.search('ubuntu', { offset: 0, limit: 50 });
  assert.equal(calls.length, 2, 'both unconditional paths must be fetched');
  assert.equal(total, 2);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Ubuntu 24.04 Desktop');
  assert.equal(items[0].category, 2000, 'fixture\'s "Movies" category name maps to the standard id 2000');
  assert.equal(items[0].size, Math.round(1500 * 1024 ** 2));
  assert.equal(items[0].seeds, 50);
  assert.equal(items[1].title, 'Ubuntu 24.04 Server');
});

test('faketracker.yml: a magnet already present in the listing is cached, so resolveMagnet needs no extra fetch', async () => {
  const result = validateDefinitionYaml(fs.readFileSync(FAKE_TRACKER_YAML, 'utf8'));
  if (!result.ok) return assert.fail('fixture must be valid');

  const { fn, calls } = fakeFetch({
    'https://faketracker.example/search/?q=x': fakeTrackerPage([fakeTrackerRow(9, 'Some Movie', 700, 10, 1, '>Movies', 'now')]),
    'https://faketracker.example/search/?page=2&q=x': fakeTrackerPage([])
  });

  const provider = createCardigannProvider(
    { key: 'faketracker', entry: { definition: 'faketracker' }, resolved: { definitionId: 'faketracker', from: 'test', definition: result.definition } },
    { fetch: fn, sleep: noSleep }
  );

  const { items } = await provider.search('x', { offset: 0, limit: 50 });
  assert.equal(items.length, 1);
  const callsBeforeResolve = calls.length;

  const resolved = await provider.resolveMagnet({ url: items[0].detailUrl });
  assert.equal(resolved.kind, 'magnet');
  assert.match(resolved.magnet, /^magnet:\?xt=urn:btih:/);
  assert.equal(calls.length, callsBeforeResolve, 'resolveMagnet must serve from cache, no network call');
});

// ---- synthetic definition: requestDelay, category filtering, magnet priority ----

function syntheticDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'synth',
    name: 'Synthetic Tracker',
    links: ['https://synth.example/'],
    caps: {
      categorymappings: [
        { id: '1', cat: 'Movies', desc: 'Movies' },
        { id: '2', cat: 'TV', desc: 'TV' }
      ]
    },
    search: {
      path: 'search?q={{ .Keywords }}',
      rows: { selector: 'tr.row' },
      fields: {
        title: { selector: 'a.title' },
        details: { selector: 'a.title', attribute: 'href' },
        category: { selector: 'td.cat' },
        size: { selector: 'td.size' },
        seeders: { selector: 'td.seeds' },
        leechers: { selector: 'td.leech' },
        date: { selector: 'td.date' },
        download: { selector: 'a.dl', attribute: 'href' }
      }
    },
    ...overrides
  };
}

function syntheticRow(n: number, cat: string, download: string): string {
  return `<tr class="row"><td><a class="title" href="/t/${n}">Item ${n}</a></td><td class="cat">${cat}</td>
    <td class="size">1 GB</td><td class="seeds">5</td><td class="leech">1</td><td class="date">now</td>
    <td><a class="dl" href="${download}">dl</a></td></tr>`;
}

test('requestDelay gates every fetch this provider instance makes, including a resolveMagnet fallback', async () => {
  const definition = syntheticDefinition({ requestDelay: 3 });
  const { fn } = fakeFetch({
    'https://synth.example/search?q=x': `<table><tbody>${syntheticRow(1, '1', 'https://synth.example/detail/1')}</tbody></table>`,
    'https://synth.example/detail/1': '<html><body><a href="magnet:?xt=urn:btih:BEEF">m</a></body></html>'
  });

  const sleeps: number[] = [];
  const provider = createCardigannProvider(
    { key: 'synth', entry: { definition: 'synth' }, resolved: { definitionId: 'synth', from: 'test', definition } },
    { fetch: fn, sleep: async (ms: number) => { sleeps.push(ms); } }
  );

  const { items } = await provider.search('x', { offset: 0, limit: 50 });
  // First call: no prior request, no wait.
  assert.equal(sleeps.length, 0);

  // The real flow (server.ts) only ever hands resolveMagnet the item's
  // detailUrl, never its download field - never the raw download URL.
  await provider.resolveMagnet({ url: items[0]?.detailUrl ?? '' });
  // Second call (a different URL, not cached - "download" field here is a
  // real link, not a magnet, so it's not cached at listing time either):
  // must be gated behind the same 3s requestDelay as the first.
  assert.equal(sleeps.length, 1);
  assert.ok((sleeps[0] as number) > 0 && (sleeps[0] as number) <= 3000);
});

test('resolveMagnet cache miss follows the row\'s own download URL, not the detail page, when they differ', async () => {
  const definition = syntheticDefinition();
  const { fn, calls } = fakeFetch({
    'https://synth.example/search?q=x': `<table><tbody>${syntheticRow(1, '1', 'https://synth.example/thankyou/1')}</tbody></table>`,
    'https://synth.example/thankyou/1': '<html><body><a href="magnet:?xt=urn:btih:FROMDOWNLOADPAGE">m</a></body></html>',
    // A canned (wrong) response for the detail page itself, so the test
    // fails loudly if resolveMagnet regresses to fetching it instead.
    'https://synth.example/t/1': '<html><body>no magnet here</body></html>'
  });

  const provider = createCardigannProvider(
    { key: 'synth', entry: { definition: 'synth' }, resolved: { definitionId: 'synth', from: 'test', definition } },
    { fetch: fn, sleep: noSleep }
  );

  const { items } = await provider.search('x', { offset: 0, limit: 50 });
  assert.equal(items[0]?.detailUrl, 'https://synth.example/t/1');

  const resolved = await provider.resolveMagnet({ url: items[0]?.detailUrl ?? '' });
  assert.equal(resolved.kind, 'magnet');
  assert.match(resolved.magnet, /FROMDOWNLOADPAGE/);
  assert.ok(
    calls.some((c) => c.url === 'https://synth.example/thankyou/1'),
    'must have fetched the row\'s own download URL'
  );
  assert.ok(
    !calls.some((c) => c.url === 'https://synth.example/t/1'),
    'must not have fetched the detail page instead'
  );
});

test('.Config.sitelink is always the resolved base URL, not user-overridable via entry.config', async () => {
  const definition = syntheticDefinition({
    search: {
      path: '{{ .Config.sitelink }}search?q={{ .Keywords }}',
      rows: { selector: 'tr.row' },
      fields: {
        title: { selector: 'a.title' },
        details: { selector: 'a.title', attribute: 'href' },
        category: { selector: 'td.cat' },
        size: { selector: 'td.size' },
        seeders: { selector: 'td.seeds' },
        leechers: { selector: 'td.leech' },
        date: { selector: 'td.date' },
        download: { selector: 'a.dl', attribute: 'href' }
      }
    }
  });
  const { fn, calls } = fakeFetch({
    'https://synth.example/search?q=x': '<table><tbody></tbody></table>'
  });

  const provider = createCardigannProvider(
    { key: 'synth', entry: { definition: 'synth', config: { sitelink: 'https://attacker.example/' } }, resolved: { definitionId: 'synth', from: 'test', definition } },
    { fetch: fn, sleep: noSleep }
  );
  await provider.search('x', { offset: 0, limit: 50 });
  assert.equal(calls[0]?.url, 'https://synth.example/search?q=x');
});

test('directMagnet priority: a bare magnet field wins over a magnet-shaped download field', async () => {
  const definition = syntheticDefinition({
    search: {
      path: 'search?q={{ .Keywords }}',
      rows: { selector: 'tr.row' },
      fields: {
        title: { selector: 'a.title' },
        details: { selector: 'a.title', attribute: 'href' },
        category: { selector: 'td.cat' },
        size: { selector: 'td.size' },
        seeders: { selector: 'td.seeds' },
        leechers: { selector: 'td.leech' },
        date: { selector: 'td.date' },
        magnet: { selector: 'a.real-magnet', attribute: 'href' },
        download: { selector: 'a.dl', attribute: 'href' }
      }
    }
  });
  const { fn } = fakeFetch({
    'https://synth.example/search?q=x':
      '<table><tbody><tr class="row"><td><a class="title" href="/t/1">Item</a></td><td class="cat">1</td>' +
      '<td class="size">1 GB</td><td class="seeds">5</td><td class="leech">1</td><td class="date">now</td>' +
      '<td><a class="real-magnet" href="magnet:?xt=urn:btih:REAL">m</a></td>' +
      '<td><a class="dl" href="magnet:?xt=urn:btih:WRONG">m</a></td></tr></tbody></table>'
  });

  const provider = createCardigannProvider(
    { key: 'synth', entry: { definition: 'synth' }, resolved: { definitionId: 'synth', from: 'test', definition } },
    { fetch: fn, sleep: noSleep }
  );
  const { items } = await provider.search('x', { offset: 0, limit: 50 });
  const resolved = await provider.resolveMagnet({ url: items[0].detailUrl });
  assert.equal(resolved.kind, 'magnet');
  assert.match(resolved.magnet, /REAL/);
});

test('a bare fields.infohash builds a magnet immediately at listing time, no download block or extra fetch needed', async () => {
  const definition = syntheticDefinition({
    search: {
      path: 'search?q={{ .Keywords }}',
      rows: { selector: 'tr.row' },
      fields: {
        title: { selector: 'a.title' },
        details: { selector: 'a.title', attribute: 'href' },
        category: { selector: 'td.cat' },
        size: { selector: 'td.size' },
        seeders: { selector: 'td.seeds' },
        leechers: { selector: 'td.leech' },
        date: { selector: 'td.date' },
        infohash: { selector: 'span.hash' }
      }
    }
  });
  const { fn, calls } = fakeFetch({
    'https://synth.example/search?q=x':
      '<table><tbody><tr class="row"><td><a class="title" href="/t/1">Item</a></td><td class="cat">1</td>' +
      '<td class="size">1 GB</td><td class="seeds">5</td><td class="leech">1</td><td class="date">now</td>' +
      `<td><span class="hash">${'C'.repeat(40)}</span></td></tr></tbody></table>`
  });

  const provider = createCardigannProvider(
    { key: 'synth', entry: { definition: 'synth' }, resolved: { definitionId: 'synth', from: 'test', definition } },
    { fetch: fn, sleep: noSleep }
  );
  const { items } = await provider.search('x', { offset: 0, limit: 50 });
  const callsAfterSearch = calls.length;
  const resolved = await provider.resolveMagnet({ url: items[0].detailUrl });
  assert.equal(resolved.kind, 'magnet');
  assert.match(resolved.magnet, new RegExp(`^magnet:\\?xt=urn:btih:${'C'.repeat(40)}`));
  assert.equal(calls.length, callsAfterSearch, 'no extra fetch - the magnet was already fully constructed at listing time');
});

test('a requested category not present in categorymappings excludes the path entirely; a matching one restricts results', async () => {
  const definition = syntheticDefinition({
    search: {
      paths: [{ path: 'search?q={{ .Keywords }}&cat={{ range .Categories }}{{.}}{{end}}' }],
      rows: { selector: 'tr.row' },
      fields: {
        title: { selector: 'a.title' },
        details: { selector: 'a.title', attribute: 'href' },
        category: { selector: 'td.cat' },
        size: { selector: 'td.size' },
        seeders: { selector: 'td.seeds' },
        leechers: { selector: 'td.leech' },
        date: { selector: 'td.date' },
        download: { selector: 'a.dl', attribute: 'href' }
      }
    }
  });
  const { fn, calls } = fakeFetch({
    'https://synth.example/search?q=x&cat=1':
      `<table><tbody>${syntheticRow(1, '1', 'https://synth.example/d/1')}${syntheticRow(2, '2', 'https://synth.example/d/2')}</tbody></table>`
  });

  const provider = createCardigannProvider(
    { key: 'synth', entry: { definition: 'synth' }, resolved: { definitionId: 'synth', from: 'test', definition } },
    { fetch: fn, sleep: noSleep }
  );

  // Requesting Torznab id 2000 (Movies) maps to this tracker's native "1",
  // matching the request URL canned above.
  const { items, total } = await provider.search('x', { offset: 0, limit: 50, categories: [2000] });
  assert.equal(calls.length, 1);
  assert.equal(total, 1, 'result-level filtering keeps only category 1 (Movies) rows, excluding the "2" (TV) row');
  assert.equal(items[0].title, 'Item 1');
});

test('provider.categories advertises every standard id reachable via categorymappings, deduped', () => {
  const definition = syntheticDefinition();
  const provider = createCardigannProvider(
    { key: 'synth', entry: { definition: 'synth' }, resolved: { definitionId: 'synth', from: 'test', definition } },
    { fetch: async () => ({ text: async () => '', buffer: async () => Buffer.from('') }), sleep: noSleep }
  );
  assert.deepEqual([...provider.categories].sort(), [2000, 5000]);
});

test('provider.searchModes is derived from caps.modes\' own keys, translated to Torznab t= values (music-search -> music, not audio)', () => {
  const definition = syntheticDefinition({
    caps: {
      categorymappings: [{ id: '1', cat: 'Movies', desc: 'Movies' }],
      modes: { search: ['q'], 'tv-search': ['q'], 'music-search': ['q'] }
    }
  });
  const provider = createCardigannProvider(
    { key: 'synth', entry: { definition: 'synth' }, resolved: { definitionId: 'synth', from: 'test', definition } },
    { fetch: async () => ({ text: async () => '', buffer: async () => Buffer.from('') }), sleep: noSleep }
  );
  assert.deepEqual(provider.searchModes, ['search', 'tvsearch', 'music']);
});

test('provider.searchModes is empty (not "search" by default) when caps.modes is absent - schema requires it, this is the honest reflection of that absence', () => {
  const definition = syntheticDefinition();
  const provider = createCardigannProvider(
    { key: 'synth', entry: { definition: 'synth' }, resolved: { definitionId: 'synth', from: 'test', definition } },
    { fetch: async () => ({ text: async () => '', buffer: async () => Buffer.from('') }), sleep: noSleep }
  );
  assert.deepEqual(provider.searchModes, []);
});

test('provider.searchParams carries each declared mode\'s own param list - what capsXml needs to advertise season/ep truthfully', () => {
  const definition = syntheticDefinition({
    caps: {
      categorymappings: [{ id: '1', cat: 'Movies', desc: 'Movies' }],
      modes: { search: ['q'], 'tv-search': ['q', 'season', 'ep'], 'movie-search': ['q'] }
    }
  });
  const provider = createCardigannProvider(
    { key: 'synth', entry: { definition: 'synth' }, resolved: { definitionId: 'synth', from: 'test', definition } },
    { fetch: async () => ({ text: async () => '', buffer: async () => Buffer.from('') }), sleep: noSleep }
  );
  assert.deepEqual(provider.searchParams, { search: ['q'], tvsearch: ['q', 'season', 'ep'], movie: ['q'] });
});

test('provider.searchParams is empty when caps.modes is absent, same honesty as searchModes', () => {
  const definition = syntheticDefinition();
  const provider = createCardigannProvider(
    { key: 'synth', entry: { definition: 'synth' }, resolved: { definitionId: 'synth', from: 'test', definition } },
    { fetch: async () => ({ text: async () => '', buffer: async () => Buffer.from('') }), sleep: noSleep }
  );
  assert.deepEqual(provider.searchParams, {});
});

// ---- season/ep -> Keywords (Prowlarr's TvSearchCriteria.EpisodeSearchString) ----

test('search: season+ep build an "S01E02" token appended to Keywords, matching Prowlarr\'s own tv-search request generator', async () => {
  const result = validateDefinitionYaml(fs.readFileSync(FAKE_TRACKER_YAML, 'utf8'));
  if (!result.ok) return assert.fail('fixture must be valid');

  const page1Url = 'https://faketracker.example/search/?q=Ubuntu%20S01E02';
  const page2Url = 'https://faketracker.example/search/?page=2&q=Ubuntu%20S01E02';
  const { fn } = fakeFetch({
    [page1Url]: fakeTrackerPage([]),
    [page2Url]: fakeTrackerPage([])
  });
  const provider = createCardigannProvider(
    { key: 'faketracker', entry: { definition: 'faketracker' }, resolved: { definitionId: 'faketracker', from: 'test', definition: result.definition } },
    { fetch: fn, sleep: noSleep }
  );

  // fakeFetch throws on any URL without a canned response, so a wrong
  // Keywords token would fail this call outright rather than silently pass.
  await provider.search('Ubuntu', { offset: 0, limit: 50, type: 'tvsearch', season: '1', ep: '2' });
});

test('search: season with no ep builds an "S01" season-pack token', async () => {
  const result = validateDefinitionYaml(fs.readFileSync(FAKE_TRACKER_YAML, 'utf8'));
  if (!result.ok) return assert.fail('fixture must be valid');

  const { fn } = fakeFetch({
    'https://faketracker.example/search/?q=Ubuntu%20S01': fakeTrackerPage([]),
    'https://faketracker.example/search/?page=2&q=Ubuntu%20S01': fakeTrackerPage([])
  });
  const provider = createCardigannProvider(
    { key: 'faketracker', entry: { definition: 'faketracker' }, resolved: { definitionId: 'faketracker', from: 'test', definition: result.definition } },
    { fetch: fn, sleep: noSleep }
  );

  await provider.search('Ubuntu', { offset: 0, limit: 50, type: 'tvsearch', season: '1' });
});

test('search: season "00" (Sonarr\'s NewznabifySeasonNumber encoding of season 0) is treated as absent, matching Prowlarr\'s "Season is null or 0" rule', async () => {
  const result = validateDefinitionYaml(fs.readFileSync(FAKE_TRACKER_YAML, 'utf8'));
  if (!result.ok) return assert.fail('fixture must be valid');

  const { fn } = fakeFetch({
    'https://faketracker.example/search/?q=Ubuntu': fakeTrackerPage([]),
    'https://faketracker.example/search/?page=2&q=Ubuntu': fakeTrackerPage([])
  });
  const provider = createCardigannProvider(
    { key: 'faketracker', entry: { definition: 'faketracker' }, resolved: { definitionId: 'faketracker', from: 'test', definition: result.definition } },
    { fetch: fn, sleep: noSleep }
  );

  await provider.search('Ubuntu', { offset: 0, limit: 50, type: 'tvsearch', season: '00', ep: '5' });
});

test('entry.link overrides links[0] as the base URL', async () => {
  const definition = syntheticDefinition({ links: ['https://synth.example/', 'https://mirror.example/'] });
  const { fn, calls } = fakeFetch({
    'https://mirror.example/search?q=x': '<table><tbody></tbody></table>'
  });
  const provider = createCardigannProvider(
    { key: 'synth', entry: { definition: 'synth', link: 'https://mirror.example/' }, resolved: { definitionId: 'synth', from: 'test', definition } },
    { fetch: fn, sleep: noSleep }
  );
  await provider.search('x', { offset: 0, limit: 50 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://mirror.example/search?q=x');
});

test('caps.settings[].default seeds .Config, overridable by entry.config; boolean defaults coerce to \'\'/\'True\' matching .False/.True', async () => {
  const definition = syntheticDefinition({
    settings: [
      { name: 'sort', type: 'select', default: 'time' },
      { name: 'strict', type: 'checkbox', default: false },
      { name: 'verbose', type: 'checkbox', default: true },
      { name: 'label', type: 'text' } // no default - must not appear in .Config at all
    ],
    search: {
      path: 'search?q={{ .Keywords }}&sort={{ .Config.sort }}&strict={{ if eq .Config.strict .False }}no{{ else }}yes{{ end }}&verbose={{ if .Config.verbose }}yes{{ else }}no{{ end }}&label={{ .Config.label }}',
      rows: { selector: 'tr.row' },
      fields: {
        title: { selector: 'a.title' },
        details: { selector: 'a.title', attribute: 'href' },
        category: { selector: 'td.cat' },
        size: { selector: 'td.size' },
        seeders: { selector: 'td.seeds' },
        leechers: { selector: 'td.leech' },
        date: { selector: 'td.date' },
        download: { selector: 'a.dl', attribute: 'href' }
      }
    }
  });

  // Defaults only, no entry.config override:
  const { fn: fn1, calls: calls1 } = fakeFetch({
    'https://synth.example/search?q=x&sort=time&strict=no&verbose=yes&label=': '<table><tbody></tbody></table>'
  });
  const provider1 = createCardigannProvider(
    { key: 'synth', entry: { definition: 'synth' }, resolved: { definitionId: 'synth', from: 'test', definition } },
    { fetch: fn1, sleep: noSleep }
  );
  await provider1.search('x', { offset: 0, limit: 50 });
  assert.equal(calls1.length, 1, 'strict default (false) rendered as .False-equal, verbose default (true) rendered truthy, label absent entirely');

  // entry.config overrides a default, and itself exercises the same
  // boolean coercion (not the pre-existing bare String(v) behavior, which
  // would have rendered false as the non-empty, therefore truthy, "false").
  const { fn: fn2, calls: calls2 } = fakeFetch({
    'https://synth.example/search?q=x&sort=seeders&strict=yes&verbose=no&label=custom': '<table><tbody></tbody></table>'
  });
  const provider2 = createCardigannProvider(
    {
      key: 'synth',
      entry: { definition: 'synth', config: { sort: 'seeders', strict: true, verbose: false, label: 'custom' } },
      resolved: { definitionId: 'synth', from: 'test', definition }
    },
    { fetch: fn2, sleep: noSleep }
  );
  await provider2.search('x', { offset: 0, limit: 50 });
  assert.equal(calls2.length, 1);
});

test('resolveMagnet threads the same .Config (settings defaults + overrides) into the download block', async () => {
  const definition = syntheticDefinition({
    settings: [{ name: 'downloadlink', type: 'select', default: 'http://itorrents.org/' }],
    search: {
      path: 'search?q={{ .Keywords }}',
      rows: { selector: 'tr.row' },
      fields: {
        title: { selector: 'a.title' },
        details: { selector: 'a.title', attribute: 'href' },
        category: { selector: 'td.cat' },
        size: { selector: 'td.size' },
        seeders: { selector: 'td.seeds' },
        leechers: { selector: 'td.leech' },
        date: { selector: 'td.date' },
        download: { selector: 'a.title', attribute: 'href' }
      }
    },
    download: {
      selectors: [{ selector: 'a[href^="{{ .Config.downloadlink }}"]', attribute: 'href' }]
    }
  });
  const torrentBytes = Buffer.from('d8:announce...e');
  const { fn, calls } = fakeFetch({
    'https://synth.example/search?q=x': '<table><tbody><tr class="row"><td><a class="title" href="/t/1">Item</a></td><td class="cat">1</td>' +
      '<td class="size">1 GB</td><td class="seeds">5</td><td class="leech">1</td><td class="date">now</td></tr></tbody></table>',
    'https://synth.example/t/1':
      '<html><body><a href="magnet:?xt=urn:btih:WRONG">wrong-kind</a><a href="http://itorrents.org/torrent/REAL.torrent">right-kind</a></body></html>',
    'http://itorrents.org/torrent/REAL.torrent': { data: torrentBytes, filename: 'REAL.torrent' }
  });

  const provider = createCardigannProvider(
    { key: 'synth', entry: { definition: 'synth' }, resolved: { definitionId: 'synth', from: 'test', definition } },
    { fetch: fn, sleep: noSleep }
  );
  const { items } = await provider.search('x', { offset: 0, limit: 50 });
  const resolved = await provider.resolveMagnet({ url: items[0].detailUrl });

  // .Config.downloadlink must have resolved to its real default
  // (http://itorrents.org/), not empty - an empty prefix would have
  // matched the first, wrong-kind (magnet), link instead. The filename
  // comes from the fetcher's own real Content-Disposition name (cfFetch's
  // own downloadFile()/Content-Disposition parse), not itemTitle -
  // resolveMagnet's cache-miss path always passes itemTitle: '' (see
  // adapter.ts), but that no longer matters here since the fetcher
  // supplies a real name regardless.
  assert.deepEqual(resolved, { kind: 'torrent', data: torrentBytes, filename: 'REAL.torrent' });
  assert.ok(calls.some((c) => c.url === 'http://itorrents.org/torrent/REAL.torrent'));
});

test('a definition with no links[] and no link: override throws at provider creation, not on first search', () => {
  const definition = syntheticDefinition({ links: [] });
  assert.throws(
    () =>
      createCardigannProvider(
        { key: 'synth', entry: { definition: 'synth' }, resolved: { definitionId: 'synth', from: 'test', definition } },
        { fetch: async () => ({ text: async () => '', buffer: async () => Buffer.from('') }), sleep: noSleep }
      ),
    /no links\[\] and no config link:/
  );
});
