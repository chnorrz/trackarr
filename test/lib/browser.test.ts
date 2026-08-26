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

type FakeDownload = {
  failure: () => Promise<string | null>;
  createReadStream: () => Promise<AsyncIterable<Buffer>>;
  suggestedFilename: () => string;
  delete: () => Promise<void>;
};

// downloadFile() waits for the page's 'download' event before navigating,
// same order Playwright's own docs use - so a goto() to a url configured
// here resolves whichever waitForEvent('download') call is currently
// pending on this page, then throws "Download is starting" itself, exactly
// mirroring Firefox's real _onDownloadCreated behavior (confirmed live and
// by reading playwright-core's own source - see NOTES.md).
let downloadTriggers: Record<string, { data: Buffer; filename: string; failure?: string | null }> = {};
let downloadDeletes = 0;
// Real code passes a real 20s timeout to waitForEvent; this fake ignores
// that value and uses its own short one so a "goto succeeded, no download
// ever fired" test doesn't have to actually wait 20 seconds.
const FAKE_DOWNLOAD_EVENT_TIMEOUT_MS = 30;

// A factory, not one shared object: recyclePage() evicts by identity, so a
// reused object would be found under every hostname at once.
const createFakePage = () => {
  const downloadWaiters: Array<(d: FakeDownload) => void> = [];

  return {
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

      const trigger = downloadTriggers[url];
      if (trigger) {
        const dl: FakeDownload = {
          failure: async () => trigger.failure ?? null,
          createReadStream: async () => (async function* () { yield trigger.data; })(),
          suggestedFilename: () => trigger.filename,
          delete: async () => { downloadDeletes++; }
        };
        const waiter = downloadWaiters.shift();
        if (waiter) waiter(dl);
        throw new Error('page.goto: Download is starting');
      }

      if (url === gotoDownloadStartingFor) throw new Error('page.goto: Download is starting');
      return { headers: () => ({}), status: () => 200 };
    },
    // Fake stand-in for Playwright's real page.waitForEvent('download', ...):
    // resolves via the goto() trigger above, or rejects on its own short
    // timeout if goto() never matched a configured download url.
    waitForEvent: async (event: string, opts?: { timeout?: number }): Promise<FakeDownload> => {
      if (event !== 'download') throw new Error(`fake page.waitForEvent: unsupported event "${event}"`);
      return new Promise((resolve, reject) => {
        downloadWaiters.push(resolve);
        setTimeout(() => {
          const idx = downloadWaiters.indexOf(resolve);
          if (idx === -1) return;
          downloadWaiters.splice(idx, 1);
          reject(new Error(`page.waitForEvent: Timeout ${opts?.timeout ?? FAKE_DOWNLOAD_EVENT_TIMEOUT_MS}ms exceeded while waiting for event "download"`));
        }, FAKE_DOWNLOAD_EVENT_TIMEOUT_MS);
      });
    },
    close: async () => {
      pageCloses++;
    },
    // Real Playwright pages expose .context() to get back to the owning
    // BrowserContext - used by cfFetch to route a Cookie header through
    // context.addCookies() instead of a (browser-forbidden) fetch() header.
    context: () => fakeContext
  };
};

let newPageCalls = 0;
let newContextCalls = 0;
let camoufoxCalls = 0;

let newPageFails = false;
let browserCloses = 0;
let addCookiesCalls: unknown[] = [];

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

const { cfFetch, closeBrowser, registerDomainCookies, downloadFile } = await import(path.join(ROOT, 'dist', 'lib', 'browser.js'));

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

test('downloadFile() returns the real bytes and the real suggested filename on a successful download', async () => {
  downloadTriggers = {
    'https://download-test.example/one.torrent': { data: Buffer.from('real torrent bytes'), filename: 'ubuntu.torrent' }
  };

  const result = await downloadFile('https://download-test.example/one.torrent');

  assert.ok(Buffer.isBuffer(result.data));
  assert.equal(result.data.toString('utf-8'), 'real torrent bytes');
  assert.equal(result.filename, 'ubuntu.torrent');
});

test('downloadFile() deletes the browser-side download copy and closes its scratch page even on success', async () => {
  downloadTriggers = { 'https://download-test.example/cleanup.torrent': { data: Buffer.from('x'), filename: 'x.torrent' } };
  downloadDeletes = 0;
  const before = pageCloses;

  await downloadFile('https://download-test.example/cleanup.torrent');

  assert.equal(downloadDeletes, 1, 'the temporary browser-side download file must be deleted, not leaked to disk');
  assert.equal(pageCloses, before + 1, 'the scratch page must be closed after use');
});

test('downloadFile() throws a clear error when the download itself failed', async () => {
  downloadTriggers = {
    'https://download-test.example/broken.torrent': { data: Buffer.from(''), filename: '', failure: 'net::ERR_CONNECTION_RESET' }
  };

  await assert.rejects(downloadFile('https://download-test.example/broken.torrent'), /net::ERR_CONNECTION_RESET/);
});

test('downloadFile() throws (rather than hanging) when the url never triggers a real download', async () => {
  downloadTriggers = {};

  await assert.rejects(downloadFile('https://download-test.example/not-a-download.html'), /Timeout.*download/);
});

test('downloadFile() routes a Cookie header through context.addCookies(), same mechanism as cfFetch', async () => {
  downloadTriggers = { 'https://download-cookie-test.example/one.torrent': { data: Buffer.from('x'), filename: 'x.torrent' } };
  addCookiesCalls = [];

  await downloadFile('https://download-cookie-test.example/one.torrent', { headers: { Cookie: 'a=1' } });

  assert.equal(addCookiesCalls.length, 1);
  assert.deepEqual(addCookiesCalls[0], [{ name: 'a', value: '1', domain: 'download-cookie-test.example', path: '/' }]);
});

test('downloadFile() still succeeds when a non-Cookie header is passed, even though a browser download cannot carry it', async () => {
  downloadTriggers = { 'https://download-test.example/with-header.torrent': { data: Buffer.from('x'), filename: 'x.torrent' } };

  const result = await downloadFile('https://download-test.example/with-header.torrent', { headers: { 'X-Api-Key': 'secret' } });

  assert.equal(result.data.toString('utf-8'), 'x');
});
