import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { createApp } = await import(path.join(ROOT, 'dist', 'server.js'));
const { ProviderStatusTracker } = await import(path.join(ROOT, 'dist', 'lib', 'status.js'));

const API_KEY = 'test-key-123';

function fakeItem(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Fake Title',
    detailUrl: 'https://example.invalid/1',
    size: 1024,
    seeds: 5,
    leechers: 2,
    category: 2000,
    pubDate: new Date('2024-01-01T00:00:00Z'),
    ...overrides
  };
}

function fakeProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fake',
    name: 'Fake Provider',
    categories: [2000, 5000],
    searchModes: ['search', 'tvsearch', 'movie'],
    search: async () => ({ items: [fakeItem()], total: 1 }),
    resolveMagnet: async () => ({ kind: 'magnet', magnet: 'magnet:?xt=urn:btih:fake' }),
    ...overrides
  };
}

async function withServer<T>(
  providers: Record<string, unknown>,
  fn: (baseUrl: string) => Promise<T>,
  appOpts: Record<string, unknown> = {}
): Promise<T> {
  const app = createApp(providers, { apiKey: API_KEY, ...appOpts });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('GET /:provider/api?t=caps needs no apikey and returns caps XML', async () => {
  await withServer({ fake: fakeProvider() }, async (base) => {
    const res = await fetch(`${base}/fake/api?t=caps`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<caps>/);
    assert.match(body, /Fake Provider/);
  });
});

test('caps always emits all 5 search elements, available reflecting the provider\'s own searchModes - never omitted', async () => {
  await withServer({ fake: fakeProvider({ searchModes: ['search', 'music'] }) }, async (base) => {
    const body = await (await fetch(`${base}/fake/api?t=caps`)).text();
    assert.match(body, /<search available="yes" supportedParams="q" \/>/);
    assert.match(body, /<tv-search available="no" supportedParams="q" \/>/);
    assert.match(body, /<movie-search available="no" supportedParams="q" \/>/);
    // music (caps.modes' own key: music-search) renders as audio-search -
    // Newznab's own naming mismatch, confirmed against Prowlarr's source.
    assert.match(body, /<audio-search available="yes" supportedParams="q" \/>/);
    assert.match(body, /<book-search available="no" supportedParams="q" \/>/);
  });
});

test('caps only advertises the categories a provider actually declares', async () => {
  await withServer({ fake: fakeProvider({ categories: [2000, 5000] }) }, async (base) => {
    const body = await (await fetch(`${base}/fake/api?t=caps`)).text();
    assert.match(body, /<category id="2000" name="Movies" \/>/);
    assert.match(body, /<category id="5000" name="TV" \/>/);
    assert.doesNotMatch(body, /name="XXX"/);
    assert.doesNotMatch(body, /name="Books"/);
  });
});

test('GET /:provider/api rejects a wrong apikey with a torznab <error> document', async () => {
  await withServer({ fake: fakeProvider() }, async (base) => {
    const res = await fetch(`${base}/fake/api?t=search&apikey=wrong`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<error code="100" description="[^"]*"\s*\/>/);
  });
});

test('unknown provider returns 404 on both routes', async () => {
  await withServer({ fake: fakeProvider() }, async (base) => {
    const res1 = await fetch(`${base}/nope/api?t=caps`);
    assert.equal(res1.status, 404);
    const res2 = await fetch(`${base}/nope/download?apikey=${API_KEY}`);
    assert.equal(res2.status, 404);
  });
});

test('search returns a Torznab RSS document built from the provider items', async () => {
  await withServer({ fake: fakeProvider() }, async (base) => {
    const res = await fetch(`${base}/fake/api?t=search&q=whatever&apikey=${API_KEY}`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<title>Fake Title<\/title>/);
    assert.match(body, /<torznab:attr name="category" value="2000" \/>/);
    assert.match(body, /<torznab:attr name="seeders" value="5" \/>/);
    assert.match(body, /<torznab:attr name="peers" value="7" \/>/);
    assert.match(body, new RegExp(`/fake/download\\?apikey=${API_KEY}&amp;url=`));
  });
});

test('title/url special characters are XML-escaped in the RSS output', async () => {
  const item = fakeItem({ title: `A & B <C> "D"`, detailUrl: 'https://example.invalid/a&b' });
  await withServer({ fake: fakeProvider({ search: async () => ({ items: [item], total: 1 }) }) }, async (base) => {
    const res = await fetch(`${base}/fake/api?t=search&q=x&apikey=${API_KEY}`);
    const body = await res.text();
    assert.match(body, /A &amp; B &lt;C&gt; &quot;D&quot;/);
    assert.doesNotMatch(body, /<title>A & B/);
  });
});

test('blank q is passed through unchanged - no more testQuery substitution', async () => {
  const calls: string[] = [];
  const provider = fakeProvider({
    search: async (q: string) => {
      calls.push(q);
      return { items: [fakeItem()], total: 1 };
    }
  });
  await withServer({ fake: provider }, async (base) => {
    const res = await fetch(`${base}/fake/api?t=search&q=&apikey=${API_KEY}`);
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['']);
  });
});

test('cat/offset/limit query params are parsed and forwarded to provider.search', async () => {
  const calls: unknown[] = [];
  const provider = fakeProvider({
    search: async (q: string, opts: unknown) => {
      calls.push(opts);
      return { items: [fakeItem()], total: 1 };
    }
  });
  await withServer({ fake: provider }, async (base) => {
    await fetch(`${base}/fake/api?t=search&q=&cat=5000&offset=20&limit=10&apikey=${API_KEY}`);
    assert.deepEqual(calls, [{ categories: [5000], offset: 20, limit: 10, type: 'search' }]);
  });
});

test('cat accepts a comma-separated list, parsed into multiple ids', async () => {
  const calls: unknown[] = [];
  const provider = fakeProvider({
    search: async (q: string, opts: unknown) => {
      calls.push(opts);
      return { items: [fakeItem()], total: 1 };
    }
  });
  await withServer({ fake: provider }, async (base) => {
    await fetch(`${base}/fake/api?t=search&q=&cat=2000,5000&apikey=${API_KEY}`);
    assert.deepEqual(calls, [{ categories: [2000, 5000], offset: 0, limit: 50, type: 'search' }]);
  });
});

test('t=tvsearch and t=movie (unhyphenated) are accepted, matching the spec function names', async () => {
  await withServer({ fake: fakeProvider() }, async (base) => {
    const tv = await fetch(`${base}/fake/api?t=tvsearch&q=x&apikey=${API_KEY}`);
    assert.equal(tv.status, 200);
    const movie = await fetch(`${base}/fake/api?t=movie&q=x&apikey=${API_KEY}`);
    assert.equal(movie.status, 200);
  });
});

test('t=music and t=book are accepted for a provider that declares them', async () => {
  await withServer({ fake: fakeProvider({ searchModes: ['search', 'music', 'book'] }) }, async (base) => {
    const music = await fetch(`${base}/fake/api?t=music&q=x&apikey=${API_KEY}`);
    assert.equal(music.status, 200);
    const book = await fetch(`${base}/fake/api?t=book&q=x&apikey=${API_KEY}`);
    assert.equal(book.status, 200);
  });
});

test('a syntactically valid t= that the provider does not declare in searchModes is rejected with <error code="203">, not passed through', async () => {
  await withServer({ fake: fakeProvider({ searchModes: ['search'] }) }, async (base) => {
    const res = await fetch(`${base}/fake/api?t=movie&q=x&apikey=${API_KEY}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<error code="203"/);
  });
});

test('the raw t= value is forwarded to provider.search() as opts.type, not the caps.modes name', async () => {
  const calls: unknown[] = [];
  const provider = fakeProvider({
    search: async (q: string, opts: unknown) => {
      calls.push(opts);
      return { items: [fakeItem()], total: 1 };
    }
  });
  await withServer({ fake: provider }, async (base) => {
    await fetch(`${base}/fake/api?t=tvsearch&q=x&apikey=${API_KEY}`);
    assert.deepEqual(calls, [{ categories: undefined, offset: 0, limit: 50, type: 'tvsearch' }]);
  });
});

test('limit is clamped to the caps-advertised max of 100', async () => {
  const calls: unknown[] = [];
  const provider = fakeProvider({
    search: async (q: string, opts: unknown) => {
      calls.push(opts);
      return { items: [fakeItem()], total: 1 };
    }
  });
  await withServer({ fake: provider }, async (base) => {
    await fetch(`${base}/fake/api?t=search&q=x&limit=500&apikey=${API_KEY}`);
    assert.deepEqual(calls, [{ categories: undefined, offset: 0, limit: 100, type: 'search' }]);
  });
});

test('missing cat/offset/limit default to no category, offset 0, limit 50', async () => {
  const calls: unknown[] = [];
  const provider = fakeProvider({
    search: async (q: string, opts: unknown) => {
      calls.push(opts);
      return { items: [fakeItem()], total: 1 };
    }
  });
  await withServer({ fake: provider }, async (base) => {
    await fetch(`${base}/fake/api?t=search&q=x&apikey=${API_KEY}`);
    assert.deepEqual(calls, [{ categories: undefined, offset: 0, limit: 50, type: 'search' }]);
  });
});

test('RSS output includes opensearch:totalResults from the provider', async () => {
  const provider = fakeProvider({ search: async () => ({ items: [fakeItem()], total: 137 }) });
  await withServer({ fake: provider }, async (base) => {
    const body = await (await fetch(`${base}/fake/api?t=search&q=x&apikey=${API_KEY}`)).text();
    assert.match(body, /<opensearch:totalResults>137<\/opensearch:totalResults>/);
    assert.match(body, /xmlns:opensearch="http:\/\/a9\.com\/-\/spec\/opensearch\/1\.1\/"/);
  });
});

test('search results are not cached at the server level - each request calls the provider fresh', async () => {
  let calls = 0;
  const provider = fakeProvider({
    search: async () => {
      calls++;
      return { items: [fakeItem()], total: 1 };
    }
  });
  await withServer({ fake: provider }, async (base) => {
    await fetch(`${base}/fake/api?t=search&q=same&apikey=${API_KEY}`);
    await fetch(`${base}/fake/api?t=search&q=same&apikey=${API_KEY}`);
    assert.equal(calls, 2);
  });
});

test('search errors surface as a torznab <error code="900"> document with the error message', async () => {
  const provider = fakeProvider({ search: async () => { throw new Error('boom'); } });
  await withServer({ fake: provider }, async (base) => {
    const res = await fetch(`${base}/fake/api?t=search&q=x&apikey=${API_KEY}`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<error code="900"/);
    assert.match(body, /boom/);
  });
});

test('unsupported t value returns a torznab <error code="203"> document', async () => {
  await withServer({ fake: fakeProvider() }, async (base) => {
    const res = await fetch(`${base}/fake/api?t=tvsearch2&apikey=${API_KEY}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<error code="203"/);
  });
});

test('offset/limit reject non-integer or negative values with a torznab <error code="201"> document', async () => {
  await withServer({ fake: fakeProvider() }, async (base) => {
    const bad = ['offset=abc', 'offset=-1', 'offset=1.5', 'limit=abc', 'limit=-1'];
    for (const param of bad) {
      const res = await fetch(`${base}/fake/api?t=search&q=x&${param}&apikey=${API_KEY}`);
      assert.equal(res.status, 200, `expected 200 for ${param}`);
      assert.match(await res.text(), /<error code="201"/, `expected error 201 for ${param}`);
    }
  });
});

test('cat rejects non-numeric or malformed values with a torznab <error code="201"> document', async () => {
  await withServer({ fake: fakeProvider() }, async (base) => {
    const bad = ['cat=abc', 'cat=2000,abc', 'cat=2000,', 'cat=2000, 5000', 'cat=-1'];
    for (const param of bad) {
      const res = await fetch(`${base}/fake/api?t=search&q=x&${param}&apikey=${API_KEY}`);
      assert.equal(res.status, 200, `expected 200 for ${param}`);
      assert.match(await res.text(), /<error code="201"/, `expected error 201 for ${param}`);
    }
  });
});

test('download redirects to the resolved magnet (302)', async () => {
  const provider = fakeProvider({ resolveMagnet: async () => ({ kind: 'magnet', magnet: 'magnet:?xt=urn:btih:deadbeef' }) });
  await withServer({ fake: provider }, async (base) => {
    const res = await fetch(`${base}/fake/download?apikey=${API_KEY}&url=https://example.invalid/1`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'magnet:?xt=urn:btih:deadbeef');
  });
});

test('download streams a real .torrent file\'s bytes directly, not a redirect', async () => {
  const torrentBytes = Buffer.from('d8:announce...e');
  const provider = fakeProvider({
    resolveMagnet: async () => ({ kind: 'torrent', data: torrentBytes, filename: 'Example.torrent' })
  });
  await withServer({ fake: provider }, async (base) => {
    const res = await fetch(`${base}/fake/download?apikey=${API_KEY}&url=https://example.invalid/1`, { redirect: 'manual' });
    assert.equal(res.status, 200, 'a real file, not a redirect the client can\'t reach on its own');
    assert.equal(res.headers.get('content-type'), 'application/x-bittorrent');
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="Example\.torrent"/);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(torrentBytes));
  });
});

test('download without url returns a torznab <error code="200"> document', async () => {
  await withServer({ fake: fakeProvider() }, async (base) => {
    const res = await fetch(`${base}/fake/download?apikey=${API_KEY}`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<error code="200"/);
  });
});

test('magnets are cached - a second identical download does not call resolveMagnet again', async () => {
  let calls = 0;
  const provider = fakeProvider({
    resolveMagnet: async () => {
      calls++;
      return { kind: 'magnet', magnet: 'magnet:?xt=urn:btih:cached' };
    }
  });
  await withServer({ fake: provider }, async (base) => {
    await fetch(`${base}/fake/download?apikey=${API_KEY}&url=https://example.invalid/1`, { redirect: 'manual' });
    await fetch(`${base}/fake/download?apikey=${API_KEY}&url=https://example.invalid/1`, { redirect: 'manual' });
    assert.equal(calls, 1);
  });
});

test('download errors surface as a torznab <error code="900"> document with the error message', async () => {
  const provider = fakeProvider({ resolveMagnet: async () => { throw new Error('resolve failed'); } });
  await withServer({ fake: provider }, async (base) => {
    const res = await fetch(`${base}/fake/download?apikey=${API_KEY}&url=https://example.invalid/1`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<error code="900"/);
    assert.match(body, /resolve failed/);
  });
});

// The page's <style> block contains these class names, so a loose substring
// match always hits - assert against the rendered <span> instead.
const badgeUnknown = /<span class="badge badge-unknown">UNKNOWN<\/span>/;
const badgeOk = /<span class="badge badge-ok">OK<\/span>/;
const badgeError = /<span class="badge badge-error">ERROR<\/span>/;

test('GET / needs no apikey and lists a provider that has never been checked as unknown', async () => {
  await withServer({ fake: fakeProvider() }, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /html/);
    const body = await res.text();
    assert.match(body, /Fake Provider/);
    assert.match(body, badgeUnknown);
  });
});

test('GET / reflects a successful search as OK', async () => {
  const statusTracker = new ProviderStatusTracker();
  await withServer({ fake: fakeProvider() }, async (base) => {
    await fetch(`${base}/fake/api?t=search&q=x&apikey=${API_KEY}`);
    const body = await (await fetch(`${base}/`)).text();
    assert.match(body, badgeOk);
    assert.doesNotMatch(body, badgeUnknown);
  }, { statusTracker });
});

test('GET / reflects a failed search as an error, with the message shown', async () => {
  const statusTracker = new ProviderStatusTracker();
  const provider = fakeProvider({ search: async () => { throw new Error('Cloudflare blocked'); } });
  await withServer({ fake: provider }, async (base) => {
    await fetch(`${base}/fake/api?t=search&q=x&apikey=${API_KEY}`);
    const body = await (await fetch(`${base}/`)).text();
    assert.match(body, badgeError);
    assert.match(body, /Cloudflare blocked/);
  }, { statusTracker });
});

test('GET / status reflects the most recent outcome, not the first', async () => {
  const statusTracker = new ProviderStatusTracker();
  let fail = true;
  const provider = fakeProvider({
    search: async () => {
      if (fail) { fail = false; throw new Error('first attempt failed'); }
      return { items: [fakeItem()], total: 1 };
    }
  });
  await withServer({ fake: provider }, async (base) => {
    await fetch(`${base}/fake/api?t=search&q=a&apikey=${API_KEY}`);
    await fetch(`${base}/fake/api?t=search&q=b&apikey=${API_KEY}`);
    const body = await (await fetch(`${base}/`)).text();
    assert.match(body, badgeOk);
    assert.doesNotMatch(body, /first attempt failed/);
  }, { statusTracker });
});

test('GET / shows "no requests yet" before any search or download has happened', async () => {
  await withServer({ fake: fakeProvider() }, async (base) => {
    const body = await (await fetch(`${base}/`)).text();
    assert.match(body, /no requests yet/);
  });
});

test('GET / request stats never show search requests as cached - server.ts has no search cache any more', async () => {
  const statusTracker = new ProviderStatusTracker();
  await withServer({ fake: fakeProvider() }, async (base) => {
    await fetch(`${base}/fake/api?t=search&q=same&apikey=${API_KEY}`);
    await fetch(`${base}/fake/api?t=search&q=same&apikey=${API_KEY}`);
    const body = await (await fetch(`${base}/`)).text();
    assert.match(body, /2 served/);
    assert.match(body, /2 ok \(0% cached\)/);
    assert.match(body, /0 failed/);
  }, { statusTracker });
});

test('GET / request stats count a failed search separately from successes', async () => {
  const statusTracker = new ProviderStatusTracker();
  let fail = true;
  const provider = fakeProvider({
    search: async () => {
      if (fail) { fail = false; throw new Error('boom'); }
      return { items: [fakeItem()], total: 1 };
    }
  });
  await withServer({ fake: provider }, async (base) => {
    await fetch(`${base}/fake/api?t=search&q=a&apikey=${API_KEY}`);
    await fetch(`${base}/fake/api?t=search&q=b&apikey=${API_KEY}`);
    const body = await (await fetch(`${base}/`)).text();
    assert.match(body, /2 served/);
    assert.match(body, /1 ok/);
    assert.match(body, /1 failed/);
  }, { statusTracker });
});

test('GET / request stats also count download requests, not just search', async () => {
  const statusTracker = new ProviderStatusTracker();
  await withServer({ fake: fakeProvider() }, async (base) => {
    await fetch(`${base}/fake/download?apikey=${API_KEY}&url=https://example.invalid/1`, { redirect: 'manual' });
    await fetch(`${base}/fake/download?apikey=${API_KEY}&url=https://example.invalid/1`, { redirect: 'manual' });
    const body = await (await fetch(`${base}/`)).text();
    assert.match(body, /2 served/);
    assert.match(body, /2 ok \(50% cached\)/);
  }, { statusTracker });
});
