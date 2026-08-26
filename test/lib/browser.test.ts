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
// Simulates a real page.evaluate() having already parsed a same-origin
// Content-Disposition header (tryFetch's own regex, which - like the
// base64/blob encoding it sits next to - runs inside the real browser
// context and isn't unit-testable outside one; this only verifies cfFetch
// threads whatever comes back through to CfResponse.filename).
let evaluateFilename: string | undefined;
let gotoUrls: string[] = [];
let gotoDownloadStartingFor: string | null = null;

type FakeCfResponse = { text(): Promise<string>; buffer(): Promise<Buffer> };

type FakeDownload = {
  failure: () => Promise<string | null>;
  createReadStream: () => Promise<AsyncIterable<Buffer>>;
  suggestedFilename: () => string;
  delete: () => Promise<void>;
};

// cfFetch's navigateOrDownload() waits for the page's 'download' event
// before navigating, same order Playwright's own docs use - so a goto() to
// a url configured here resolves whichever waitForEvent('download') call
// is currently pending on this page, then throws "Download is starting"
// itself, exactly mirroring Firefox's real _onDownloadCreated behavior
// (confirmed live and by reading playwright-core's own source - see
// NOTES.md).
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
      return {
        challenged: false,
        base64: Buffer.from('<html><body>cleared, not a challenge</body></html>').toString('base64'),
        filename: evaluateFilename
      };
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

const { cfFetch, closeBrowser, registerDomainCookies } = await import(path.join(ROOT, 'dist', 'lib', 'browser.js'));

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

test('a POST\'s own warm-up navigation falls back to the bare origin, never treated as a download, even if the url resolves as one', async () => {
  gotoUrls = [];
  lastEvaluateInit = undefined;
  gotoDownloadStartingFor = 'https://goto-fallback-test.example/submit';
  // allowDownload is method==='GET' with no body only (see fetchViaSession)
  // - a POST silently returning a downloaded file's bytes instead of ever
  // performing the POST would be a real, non-obvious bug, so this url's
  // "Download is starting" must still fall back to warming the bare
  // origin, exactly like the pre-download-detection behavior. The actual
  // POST itself is unaffected - it still goes out via tryFetch's own
  // in-page fetch() afterwards, method and body intact.
  await cfFetch('https://goto-fallback-test.example/submit', { method: 'POST', body: 'x=1' });
  assert.deepEqual(gotoUrls, ['https://goto-fallback-test.example/submit', 'https://goto-fallback-test.example/']);
  assert.deepEqual(lastEvaluateInit, { method: 'POST', headers: undefined, body: 'x=1' });
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

test('cfFetch auto-detects a real download on a plain GET and returns its real bytes and filename via CfResponse', async () => {
  downloadTriggers = {
    'https://download-test.example/one.torrent': { data: Buffer.from('real torrent bytes'), filename: 'ubuntu.torrent' }
  };

  const res = await cfFetch('https://download-test.example/one.torrent');
  const buf = await res.buffer();

  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.toString('utf-8'), 'real torrent bytes');
  assert.equal(res.filename, 'ubuntu.torrent');
});

test('CfResponse.filename carries a same-origin Content-Disposition name through, for a file fetched via the fast in-page path rather than a real Download', async () => {
  evaluateFilename = 'same-origin-name.torrent';
  const res = await cfFetch('https://filename-test.example/one');
  assert.equal(res.filename, 'same-origin-name.torrent');
  evaluateFilename = undefined;
});

test('CfResponse.filename is undefined for a plain page response with no Content-Disposition', async () => {
  evaluateFilename = undefined;
  const res = await cfFetch('https://no-filename-test.example/one');
  assert.equal(res.filename, undefined);
});

test('a GET whose armed download waiter never fires still succeeds as a normal page fetch, not a hang or a crash', async () => {
  // Every plain GET arms a download waiter before its warm-up nav (see
  // navigateOrDownload) in case the url turns out to be one - here it
  // doesn't, so this also proves the armed-but-unused waiter's own
  // eventual timeout rejection is swallowed rather than surfacing as an
  // unhandled rejection (there is no separate downloadFile() any more with
  // its own dead end for a non-download url - a GET simply succeeds
  // normally instead).
  downloadTriggers = {};
  const text = await (await cfFetch('https://not-a-download-test.example/page.html')).text();
  assert.equal(text, '<html><body>cleared, not a challenge</body></html>');
});

test('cfFetch deletes the browser-side download copy, even though the caller never sees the Download object directly', async () => {
  downloadTriggers = { 'https://download-test.example/cleanup.torrent': { data: Buffer.from('x'), filename: 'x.torrent' } };
  downloadDeletes = 0;

  await cfFetch('https://download-test.example/cleanup.torrent');

  assert.equal(downloadDeletes, 1, 'the temporary browser-side download file must be deleted, not leaked to disk');
});

test('cfFetch throws a clear error when the download itself failed', async () => {
  downloadTriggers = {
    'https://download-test.example/broken.torrent': { data: Buffer.from(''), filename: '', failure: 'net::ERR_CONNECTION_RESET' }
  };

  await assert.rejects(cfFetch('https://download-test.example/broken.torrent'), /net::ERR_CONNECTION_RESET/);
});

test('cfFetch results from a download are never cached, unlike a normal page response', async () => {
  downloadTriggers = { 'https://download-test.example/repeat.torrent': { data: Buffer.from('bytes'), filename: 'x.torrent' } };
  gotoUrls = [];

  await cfFetch('https://download-test.example/repeat.torrent');
  await cfFetch('https://download-test.example/repeat.torrent');

  // A cached result would short-circuit before ever touching the page -
  // gotoUrls staying at 1 would mean the second call served from cache.
  assert.deepEqual(gotoUrls, ['https://download-test.example/repeat.torrent', 'https://download-test.example/repeat.torrent']);
});

test('cfFetch routes a Cookie header through context.addCookies() the same way whether the url resolves as a page or a download', async () => {
  downloadTriggers = { 'https://download-cookie-test.example/one.torrent': { data: Buffer.from('x'), filename: 'x.torrent' } };
  addCookiesCalls = [];

  await cfFetch('https://download-cookie-test.example/one.torrent', { headers: { Cookie: 'a=1' } });

  assert.equal(addCookiesCalls.length, 1);
  assert.deepEqual(addCookiesCalls[0], [{ name: 'a', value: '1', domain: 'download-cookie-test.example', path: '/' }]);
});

test('cfFetch still succeeds when a non-Cookie header is passed to a url that turns out to be a download, even though a browser download cannot carry it', async () => {
  downloadTriggers = { 'https://download-test.example/with-header.torrent': { data: Buffer.from('x'), filename: 'x.torrent' } };

  const res = await cfFetch('https://download-test.example/with-header.torrent', { headers: { 'X-Api-Key': 'secret' } });

  assert.equal((await res.buffer()).toString('utf-8'), 'x');
});
