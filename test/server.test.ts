import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { createApp } = await import(path.join(ROOT, 'dist', 'server.js'));

const API_KEY = 'test-key-123';

function fakeItem(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Fake Title',
    detailUrl: 'https://example.invalid/1',
    id: 42,
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
    testQuery: 'yify',
    search: async () => [fakeItem()],
    resolveMagnet: async () => 'magnet:?xt=urn:btih:fake',
    ...overrides
  };
}

// Real listening server on an OS-picked ephemeral port (port 0) rather than
// hitting the Express app in-process - exercises the actual HTTP layer
// (status codes, headers, real query-string parsing), closer to what
// Prowlarr actually does.
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

test('GET /:provider/api rejects a wrong apikey', async () => {
  await withServer({ fake: fakeProvider() }, async (base) => {
    const res = await fetch(`${base}/fake/api?t=search&apikey=wrong`);
    assert.equal(res.status, 401);
  });
});

test('unknown provider returns 404 on both routes', async () => {
  await withServer({ fake: fakeProvider() }, async (base) => {
    const res1 = await fetch(`${base}/nope/api?t=caps`);
    assert.equal(res1.status, 404);
    const res2 = await fetch(`${base}/nope/download?apikey=${API_KEY}&id=1`);
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
    assert.match(body, /<torznab:attr name="peers" value="7" \/>/); // seeds + leechers
    // download link carries the item's id and the configured apikey (& is
    // XML-escaped to &amp; in the RSS output, as it must be)
    assert.match(body, new RegExp(`/fake/download\\?apikey=${API_KEY}&amp;id=42&amp;url=`));
  });
});

test('title/url special characters are XML-escaped in the RSS output', async () => {
  const item = fakeItem({ title: `A & B <C> "D"`, detailUrl: 'https://example.invalid/a&b' });
  await withServer({ fake: fakeProvider({ search: async () => [item] }) }, async (base) => {
    const res = await fetch(`${base}/fake/api?t=search&q=x&apikey=${API_KEY}`);
    const body = await res.text();
    assert.match(body, /A &amp; B &lt;C&gt; &quot;D&quot;/);
    assert.doesNotMatch(body, /<title>A & B/); // raw & would make this invalid XML
  });
});

test('blank q substitutes testQuery, passed through to provider.search', async () => {
  const calls: string[] = [];
  const provider = fakeProvider({
    testQuery: 'MeGusta',
    search: async (q: string) => {
      calls.push(q);
      return [fakeItem()];
    }
  });
  await withServer({ fake: provider }, async (base) => {
    const res = await fetch(`${base}/fake/api?t=search&q=&apikey=${API_KEY}`);
    assert.equal(res.status, 200);
    assert.deepEqual(calls, ['MeGusta']);
  });
});

test('search results are cached - a second identical search does not call the provider again', async () => {
  let calls = 0;
  const provider = fakeProvider({
    search: async () => {
      calls++;
      return [fakeItem()];
    }
  });
  await withServer({ fake: provider }, async (base) => {
    await fetch(`${base}/fake/api?t=search&q=same&apikey=${API_KEY}`);
    await fetch(`${base}/fake/api?t=search&q=same&apikey=${API_KEY}`);
    assert.equal(calls, 1);
  });
});

test('empty results are never cached - a transient failure recovers on retry', async () => {
  let calls = 0;
  const provider = fakeProvider({
    search: async () => {
      calls++;
      return calls === 1 ? [] : [fakeItem()];
    }
  });
  await withServer({ fake: provider }, async (base) => {
    const first = await (await fetch(`${base}/fake/api?t=search&q=same&apikey=${API_KEY}`)).text();
    assert.doesNotMatch(first, /<item>/);
    const second = await (await fetch(`${base}/fake/api?t=search&q=same&apikey=${API_KEY}`)).text();
    assert.match(second, /<item>/);
    assert.equal(calls, 2); // proves the empty first result wasn't cached
  });
});

test('search errors surface as 500 with the error message', async () => {
  const provider = fakeProvider({ search: async () => { throw new Error('boom'); } });
  await withServer({ fake: provider }, async (base) => {
    const res = await fetch(`${base}/fake/api?t=search&q=x&apikey=${API_KEY}`);
    assert.equal(res.status, 500);
    assert.match(await res.text(), /boom/);
  });
});

test('unsupported t value returns 400', async () => {
  await withServer({ fake: fakeProvider() }, async (base) => {
    const res = await fetch(`${base}/fake/api?t=tvsearch2&apikey=${API_KEY}`);
    assert.equal(res.status, 400);
  });
});

test('download redirects to the resolved magnet (302)', async () => {
  const provider = fakeProvider({ resolveMagnet: async () => 'magnet:?xt=urn:btih:deadbeef' });
  await withServer({ fake: provider }, async (base) => {
    const res = await fetch(`${base}/fake/download?apikey=${API_KEY}&id=42`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'magnet:?xt=urn:btih:deadbeef');
  });
});

test('download without id or url returns 400', async () => {
  await withServer({ fake: fakeProvider() }, async (base) => {
    const res = await fetch(`${base}/fake/download?apikey=${API_KEY}`, { redirect: 'manual' });
    assert.equal(res.status, 400);
  });
});

test('magnets are cached - a second identical download does not call resolveMagnet again', async () => {
  let calls = 0;
  const provider = fakeProvider({
    resolveMagnet: async () => {
      calls++;
      return 'magnet:?xt=urn:btih:cached';
    }
  });
  await withServer({ fake: provider }, async (base) => {
    await fetch(`${base}/fake/download?apikey=${API_KEY}&id=1`, { redirect: 'manual' });
    await fetch(`${base}/fake/download?apikey=${API_KEY}&id=1`, { redirect: 'manual' });
    assert.equal(calls, 1);
  });
});

test('download errors surface as 500 with the error message', async () => {
  const provider = fakeProvider({ resolveMagnet: async () => { throw new Error('resolve failed'); } });
  await withServer({ fake: provider }, async (base) => {
    const res = await fetch(`${base}/fake/download?apikey=${API_KEY}&id=1`, { redirect: 'manual' });
    assert.equal(res.status, 500);
    assert.match(await res.text(), /resolve failed/);
  });
});
