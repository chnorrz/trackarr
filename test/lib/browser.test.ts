import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// Read once at module load, same as the real DOMAIN_OVER_PROXY/PROXY_URL -
// must be set before the dynamic import() below.
process.env.PROXY_URL = 'http://fake-proxy.invalid:8888';
process.env.DOMAIN_OVER_PROXY = 'proxy-test.example';

let gotoFails = false;
let pageCloses = 0;

// Tracks overlap of evaluate() calls across pages, to prove (or disprove)
// that two cfFetch() operations for the same hostname never run at once.
let activeEvaluates = 0;
let maxActiveEvaluates = 0;
let evaluateDelayMs = 0;
let lastEvaluateInit: unknown;
let gotoUrls: string[] = [];
let gotoDownloadStartingFor: string | null = null;

type FakeCfResponse = { text(): Promise<string>; buffer(): Promise<Buffer> };

// A factory, not one shared object: recyclePage() evicts by identity, so a
// reused object would be found under every hostname at once.
const createFakePage = () => ({
  isClosed: () => false,
  evaluate: async (_fn: unknown, arg: { init?: unknown }) => {
    activeEvaluates++;
    maxActiveEvaluates = Math.max(maxActiveEvaluates, activeEvaluates);
    lastEvaluateInit = arg?.init;
    await new Promise((r) => setTimeout(r, evaluateDelayMs));
    activeEvaluates--;
    return { challenged: false, base64: Buffer.from('<html><body>cleared, not a challenge</body></html>').toString('base64') };
  },
  url: () => 'about:blank',
  goto: async (url: string) => {
    gotoUrls.push(url);
    if (gotoFails) throw new Error('page.goto: Timeout 15000ms exceeded.');
    if (url === gotoDownloadStartingFor) throw new Error('page.goto: Download is starting');
    return { headers: () => ({}), status: () => 200 };
  },
  close: async () => {
    pageCloses++;
  },
  // Real Playwright pages expose .context() to get back to the owning
  // BrowserContext - used by cfFetch to route a Cookie header through
  // context.addCookies() instead of a (browser-forbidden) fetch() header.
  context: () => fakeContext
});

let newPageCalls = 0;
let newContextCalls = 0;
let camoufoxCalls = 0;

let newPageFails = false;
let browserCloses = 0;
let addCookiesCalls: unknown[] = [];
let requestFetchCalls: { url: string; opts: unknown }[] = [];
let requestFetchResult: { ok: boolean; status: number; statusText: string; body: Buffer } = {
  ok: true,
  status: 200,
  statusText: 'OK',
  body: Buffer.from('fake file bytes')
};

const fakeContext = {
  newPage: async () => {
    newPageCalls++;
    // Widens the race window so both callers are genuinely in-flight at once.
    await new Promise((r) => setTimeout(r, 20));
    if (newPageFails) throw new Error('newPage: Target closed');
    return createFakePage();
  },
  cookies: async () => [],
  addCookies: async (cookies: unknown) => {
    addCookiesCalls.push(cookies);
  },
  // Playwright's APIRequestContext - used by fetchFileDirect() instead of
  // page.goto()/tryFetch() for raw file fetches (a .torrent, in practice),
  // since a direct-download response breaks page.goto() outright.
  request: {
    fetch: async (url: string, opts: unknown) => {
      requestFetchCalls.push({ url, opts });
      const result = requestFetchResult;
      return { ok: () => result.ok, status: () => result.status, statusText: () => result.statusText, body: async () => result.body };
    }
  }
};

const fakeBrowser = {
  newContext: async () => {
    newContextCalls++;
    return fakeContext;
  },
  close: async () => {
    browserCloses++;
  }
};

mock.module('camoufox-js', {
  exports: {
    Camoufox: async () => {
      camoufoxCalls++;
      return fakeBrowser;
    }
  }
});

// fetchFileDirect()'s proxied path uses Playwright's own top-level
// request.newContext() (a standalone APIRequestContext, distinct from the
// browser session's context.request) - a real network client if not
// mocked, so it needs its own fake here, separate from fakeContext.request
// above (which only ever backs the shared, non-proxied path).
let proxiedNewContextCalls: unknown[] = [];
const fakeProxiedRequestContext = {
  fetch: async (url: string, opts: unknown) => {
    requestFetchCalls.push({ url, opts });
    const result = requestFetchResult;
    return { ok: () => result.ok, status: () => result.status, statusText: () => result.statusText, body: async () => result.body };
  },
  dispose: async () => {}
};

mock.module('playwright-core', {
  exports: {
    request: {
      newContext: async (opts: unknown) => {
        proxiedNewContextCalls.push(opts);
        return fakeProxiedRequestContext;
      }
    }
  }
});

const { cfFetch, closeBrowser, registerDomainCookies, fetchFileDirect } = await import(path.join(ROOT, 'dist', 'lib', 'browser.js'));

test('concurrent cfFetch calls for the same new hostname only create one page', async () => {
  newPageCalls = 0;
  newContextCalls = 0;
  camoufoxCalls = 0;

  // Different paths = different cfFetch cache keys, so both calls reach
  // getOrCreatePersistentPage() instead of one hitting the response cache.
  const [a, b] = await Promise.all([
    cfFetch('https://race-test.example/one').then((r: FakeCfResponse) => r.text()),
    cfFetch('https://race-test.example/two').then((r: FakeCfResponse) => r.text())
  ]);

  assert.equal(a, '<html><body>cleared, not a challenge</body></html>');
  assert.equal(b, '<html><body>cleared, not a challenge</body></html>');
  assert.equal(newPageCalls, 1, 'two concurrent first callers for the same hostname must share one page, not create two');
  assert.equal(newContextCalls, 1, 'the underlying browser/context must also only be launched once');
  assert.equal(camoufoxCalls, 1);
});

test('a page that failed is thrown away instead of being handed to the next caller', async () => {
  newPageCalls = 0;
  pageCloses = 0;

  gotoFails = true;
  await assert.rejects(
    cfFetch('https://wedge-test.example/one'),
    /Timeout 15000ms/,
    'the original failure must still reach the caller'
  );
  assert.equal(newPageCalls, 1);
  assert.equal(pageCloses, 1, 'the failed page must be closed, not left open');

  gotoFails = false;
  const recovered = await (await cfFetch('https://wedge-test.example/two')).text();

  assert.equal(recovered, '<html><body>cleared, not a challenge</body></html>');
  assert.equal(newPageCalls, 2, 'the next call must build a fresh page, not reuse the failed one');
});

test('a session that cannot open a page is torn down, not leaked', async () => {
  camoufoxCalls = 0;
  browserCloses = 0;

  newPageFails = true;
  await assert.rejects(
    cfFetch('https://leak-test.example/one'),
    /Target closed/
  );
  assert.equal(browserCloses, 1, 'the unusable browser must be closed, not orphaned');

  newPageFails = false;
  const recovered = await (await cfFetch('https://leak-test.example/two')).text();

  assert.equal(recovered, '<html><body>cleared, not a challenge</body></html>');
  assert.equal(camoufoxCalls, 1, 'the next call must launch a fresh browser');
});

test('cookies registered for a domain are re-applied after a session is discarded and relaunched', async () => {
  addCookiesCalls = [];
  // Force a fresh launchSession() call below, rather than reusing whatever
  // context earlier tests already created (which was built with no cookies
  // registered).
  await closeBrowser();

  registerDomainCookies([{ name: 'layout', value: 'def_wlinks', domain: 'cookie-test.example' }]);

  await cfFetch('https://cookie-test.example/one');
  assert.equal(addCookiesCalls.length, 1);
  assert.deepEqual(addCookiesCalls[0], [{ name: 'layout', value: 'def_wlinks', domain: 'cookie-test.example', path: '/' }]);

  // A distinct hostname, so this reaches context.newPage() rather than
  // reusing the still-open persistent page from the call above.
  newPageFails = true;
  await assert.rejects(cfFetch('https://cookie-test-b.example/two'));
  newPageFails = false;

  await cfFetch('https://cookie-test-c.example/three');
  assert.equal(addCookiesCalls.length, 2, 'cookies must be re-applied on the fresh context after the discarded session relaunches');
});

test('cfFetch calls to the same hostname are serialized, not run concurrently on the shared page', async () => {
  activeEvaluates = 0;
  maxActiveEvaluates = 0;
  evaluateDelayMs = 30;

  await Promise.all([
    cfFetch('https://serial-test.example/one'),
    cfFetch('https://serial-test.example/two')
  ]);

  evaluateDelayMs = 0;
  assert.equal(maxActiveEvaluates, 1, 'a second call for the same hostname must wait for the first to finish, not touch the page alongside it');
});

test('a Cookie header in opts is routed through context.addCookies(), not sent as a fetch() header', async () => {
  addCookiesCalls = [];
  lastEvaluateInit = undefined;

  await cfFetch('https://cookie-header-test.example/one', {
    headers: { Cookie: 'a=1; b=2', 'X-Requested-With': 'XMLHttpRequest' }
  });

  assert.equal(addCookiesCalls.length, 1);
  assert.deepEqual(addCookiesCalls[0], [
    { name: 'a', value: '1', domain: 'cookie-header-test.example', path: '/' },
    { name: 'b', value: '2', domain: 'cookie-header-test.example', path: '/' }
  ]);

  // Cookie is a forbidden header name for page-context fetch() - it must
  // not be forwarded there at all, even though the browser would only
  // silently ignore it; the other header must still go through untouched.
  assert.deepEqual(lastEvaluateInit, { method: 'GET', headers: { 'X-Requested-With': 'XMLHttpRequest' }, body: undefined });
});

test('cfFetch calls to different hostnames are not serialized against each other', async () => {
  activeEvaluates = 0;
  maxActiveEvaluates = 0;
  evaluateDelayMs = 30;

  await Promise.all([
    cfFetch('https://serial-test-a.example/one'),
    cfFetch('https://serial-test-b.example/one')
  ]);

  evaluateDelayMs = 0;
  assert.equal(maxActiveEvaluates, 2, 'unrelated hostnames must be able to fetch at the same time, not queue behind one another');
});

test('the first navigation for a new page targets the exact url, not just the bare origin', async () => {
  gotoUrls = [];
  gotoDownloadStartingFor = null;
  // A challenge (or a block) is frequently scoped to the specific path, not
  // the whole origin (hit live: eztvx.to's bare "/" navigates cleanly while
  // "/search/..." independently shows Cloudflare's own challenge) -
  // navigating to just the origin would miss detecting/solving it.
  await cfFetch('https://goto-exact-test.example/deep/path?a=1');
  assert.deepEqual(gotoUrls, ['https://goto-exact-test.example/deep/path?a=1']);
});

test('navigation falls back to the bare origin only when the exact url itself throws "Download is starting"', async () => {
  gotoUrls = [];
  gotoDownloadStartingFor = 'https://goto-fallback-test.example/file.torrent';
  // A real, direct-download URL (itorrents.org's own .torrent links do
  // this) makes Playwright's page.goto() throw "Download is starting"
  // instead of navigating - hit live. Only fetch()'s own in-page call
  // (inside tryFetch, never subject to that download interception) may
  // ever target such a url directly; goto() falls back to warming up the
  // origin instead.
  await cfFetch('https://goto-fallback-test.example/file.torrent');
  assert.deepEqual(gotoUrls, ['https://goto-fallback-test.example/file.torrent', 'https://goto-fallback-test.example/']);
  gotoDownloadStartingFor = null;
});

test('CfResponse.text() and .buffer() decode the same underlying response, callable any number of times', async () => {
  const res: FakeCfResponse = await cfFetch('https://response-test.example/one');
  const text = await res.text();
  const buf = await res.buffer();
  const textAgain = await res.text();

  assert.equal(text, '<html><body>cleared, not a challenge</body></html>');
  assert.equal(textAgain, text, 'unlike a real streamed Response, calling text() twice is not an error - the body was already fully read');
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString('utf-8'), '<html><body>cleared, not a challenge</body></html>');
});

test('fetchFileDirect() returns the real bytes on a 200, via the shared (non-proxied) request context for a normal host', async () => {
  requestFetchCalls = [];
  proxiedNewContextCalls = [];
  requestFetchResult = { ok: true, status: 200, statusText: 'OK', body: Buffer.from('real torrent bytes') };

  const buf = await fetchFileDirect('https://file-test.example/one.torrent');

  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString('utf-8'), 'real torrent bytes');
  assert.equal(requestFetchCalls.length, 1);
  assert.equal(requestFetchCalls[0]?.url, 'https://file-test.example/one.torrent');
  assert.equal(proxiedNewContextCalls.length, 0, 'a host that is not DOMAIN_OVER_PROXY must never create the proxied request context at all');
});

test('fetchFileDirect() throws with the real status and statusText on a non-2xx response', async () => {
  requestFetchResult = { ok: false, status: 403, statusText: 'Forbidden', body: Buffer.from('<html>blocked</html>') };

  await assert.rejects(fetchFileDirect('https://file-test.example/dead.torrent'), /403 Forbidden/);
});

test('fetchFileDirect() routes a DOMAIN_OVER_PROXY host through a dedicated proxied request context, not the shared one', async () => {
  requestFetchCalls = [];
  proxiedNewContextCalls = [];
  requestFetchResult = { ok: true, status: 200, statusText: 'OK', body: Buffer.from('proxied bytes') };

  const buf = await fetchFileDirect('https://proxy-test.example/one.torrent');
  assert.equal(buf.toString('utf-8'), 'proxied bytes');
  assert.equal(proxiedNewContextCalls.length, 1);
  assert.deepEqual(proxiedNewContextCalls[0], { proxy: { server: 'http://fake-proxy.invalid:8888' } });

  // A second call, same or different DOMAIN_OVER_PROXY host, reuses the
  // one already-created proxied context rather than making a new one -
  // same lazy-singleton pattern the browser session itself uses.
  await fetchFileDirect('https://sub.proxy-test.example/two.torrent');
  assert.equal(proxiedNewContextCalls.length, 1, 'the proxied request context is created once and reused, not per call');
  assert.equal(requestFetchCalls.length, 2);
});
