import crypto from 'crypto';
import { Camoufox } from 'camoufox-js';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { TTLCache } from './cache.js';
import { isBlocked, solveChallenge } from './challenge.js';
import { Response as PlaywrightResponse } from 'playwright-core';
import type { ProviderCookie } from './types.js';

// Must stay within the Xvfb geometry in the Dockerfile's CMD: a window larger
// than the screen renders partly off-screen and is a detectable tell.
const WINDOW_SIZE: [number, number] = [1280, 800];
const PROXY_URL = process.env.PROXY_URL || null;
const DOMAIN_OVER_PROXY = (process.env.DOMAIN_OVER_PROXY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

type BrowserSession = { browser: Browser; context: BrowserContext };

let session: Promise<BrowserSession> | null = null;

// Providers register cookies once at startup; applied to every fresh context
// so a session discard/relaunch (e.g. after a browser crash) doesn't drop them.
let registeredCookies: ProviderCookie[] = [];

export function registerDomainCookies(cookies: ProviderCookie[]): void {
  registeredCookies = registeredCookies.concat(cookies);
}

// XTEST input is global to the X display, and concurrent navigations to one
// Cloudflare-protected host hang until the page.goto timeout.
function createSerializer() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => {},
      () => {}
    );
    return run;
  };
}

const serializeSolve = createSerializer();
const serializeNav = createSerializer();

// Routes only DOMAIN_OVER_PROXY through the proxy: Playwright's own `proxy`
// option is proxy-by-default plus bypass and cannot express that shape.
function buildPacDataUri(): string | null {
  if (!PROXY_URL || DOMAIN_OVER_PROXY.length === 0) return null;
  const proxyHost = new URL(PROXY_URL).host;
  const pac = `function FindProxyForURL(url, host) {
  var domains = ${JSON.stringify(DOMAIN_OVER_PROXY)};
  for (var i = 0; i < domains.length; i++) {
    var d = domains[i];
    if (host === d || host.substring(host.length - d.length - 1) === '.' + d) {
      return "PROXY ${proxyHost}";
    }
  }
  return "DIRECT";
}`;
  return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString('base64')}`;
}

function getSession(): Promise<BrowserSession> {
  if (!session) {
    session = launchSession().catch((err) => {
      session = null;
      throw err;
    });
  }

  return session;
}

// Closing the browser is best-effort: it may already be gone, which is the
// usual reason we are discarding the session in the first place.
async function discardSession(): Promise<void> {
  const current = session;
  session = null;
  persistentPages.clear();
  persistentPagePromises.clear();

  const live = await current?.catch(() => null);
  try {
    await live?.browser.close();
  } catch { /* already gone */ }
}

async function launchSession(): Promise<BrowserSession> {
  // Camoufox's own 'virtual' mode also uses Xvfb but at 1x1, leaving no room to
  // render or click the Turnstile widget, so on Linux run against DISPLAY.
  const headless = process.platform === 'linux' ? false : true;
  const os = process.platform === 'linux' ? ('linux' as const) : undefined;

  const pacDataUri = buildPacDataUri();
  if (pacDataUri) {
    console.error(`[cf] proxying [${DOMAIN_OVER_PROXY.join(', ')}] via ${PROXY_URL}, direct otherwise.`);
  }
  const firefoxPrefs = pacDataUri
    ? { 'network.proxy.type': 2, 'network.proxy.autoconfig_url': pacDataUri }
    : undefined;

  // Keep the argument as one object literal: Camoufox()'s return type is
  // generic on user_data_dir, and hoisting it to a variable loses that.
  const browser = os
    ? await Camoufox({ headless, os, window: WINDOW_SIZE, ...(firefoxPrefs ? { firefox_user_prefs: firefoxPrefs } : {}) })
    : await Camoufox({ headless, window: WINDOW_SIZE, ...(firefoxPrefs ? { firefox_user_prefs: firefoxPrefs } : {}) });

  const context = await browser.newContext();
  if (registeredCookies.length) {
    await context.addCookies(registeredCookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path ?? '/' })));
  }

  return { browser, context };
}

// Narrower than RequestInit on purpose: these values are serialized into
// page.evaluate(), so a stream/Blob/FormData body would silently arrive as {}.
export type FetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

const persistentPages = new Map<string, Page>();
const persistentPagePromises = new Map<string, Promise<Page>>();

async function getOrCreatePersistentPage(hostname: string): Promise<Page> {
  const existing = persistentPages.get(hostname);

  if (existing && !existing.isClosed()) {
    return existing;
  }

  persistentPages.delete(hostname);

  // Nothing may await between this lookup and the set below, or two
  // concurrent callers would each open a page for one hostname.
  let pending = persistentPagePromises.get(hostname);

  if (!pending) {
    pending = openPersistentPage(hostname);
    persistentPagePromises.set(hostname, pending);
  }

  return pending;
}

async function openPersistentPage(hostname: string): Promise<Page> {
  try {
    const { context } = await getSession();
    const page = await context.newPage();
    persistentPages.set(hostname, page);
    return page;
  } catch (err) {
    await discardSession();
    throw err;
  } finally {
    persistentPagePromises.delete(hostname);
  }
}

function recyclePage(page: Page): void {
  for (const [hostname, tracked] of persistentPages) {
    if (tracked === page) {
      persistentPages.delete(hostname);
      break;
    }
  }

  void page.close().catch(() => {});
}

type TryFetchResponse = { challenged: false, content: string} | { challenged: true } | null;

async function tryFetch(page: Page, url: string, init: FetchOptions): Promise<TryFetchResponse> {
  if (page.isClosed()) return null;
  try {
    return await page.evaluate<TryFetchResponse, { url: string; init: FetchOptions }>(async ({ url, init }) => {
      const res = await fetch(url, init);
      return res.headers.get('cf-mitigated') === 'challenge'
        ? { challenged: true }
        : { challenged: false, content: await res.text() };
    }, { url, init });
  } catch {
    return null;
  }
}

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000;
const pageCache = new TTLCache<string>(CACHE_TTL_MS);

export function isChallenge(response: TryFetchResponse | PlaywrightResponse | null): response is { challenged: true } | PlaywrightResponse {
  if (response === null) return false;
  if ('challenged' in response) return response.challenged;
  return response.headers()['cf-mitigated'] === 'challenge';
}

export async function cfFetch(url: string, opts: FetchOptions = {}): Promise<string> {
  const { method = 'GET', headers, body } = opts;
  const init: FetchOptions = { method, headers, body };
  const cacheKey = crypto.createHash('sha256').update(`${method}:${url}:${body ?? ''}`).digest('hex');

  const cached = pageCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const page = await getOrCreatePersistentPage(new URL(url).hostname);

  try {
    // A new page sits on about:blank, where fetch()'s same-origin rules make
    // tryFetch() fail regardless of cookies - not a challenge signal.
    let firstNav = false;
    let response: PlaywrightResponse | null = null;

    if (page.url() === 'about:blank') {
      response = await serializeNav(() => page.goto(url, { waitUntil: 'commit', timeout: 15000 }));
      firstNav = true;
    }

    if (!isChallenge(response)) {
      const fast = await tryFetch(page, url, init);
      if (fast !== null && !isChallenge(fast)) {
        if (isBlocked(fast.content)) {
          throw new Error(`cfFetch: fetch failed for ${url} even though the page shows no challenge - probably your IP got blocked.`);
        }
        pageCache.set(cacheKey, fast.content);
        return fast.content;
      }
    }

    console.error(`[cf] cfFetch: fast path unavailable for ${url}, recovering session.`);
    if (!firstNav) {
      response = await serializeNav(() => page.goto(url, { waitUntil: 'commit', timeout: 15000 }));
    }

    if (isChallenge(response)) {
      const clearance = await serializeSolve(async () => {
        await page.waitForLoadState('load', { timeout: 60000 }).catch(() => {});

        try {
          return await solveChallenge(page);
        } catch (err: unknown) {
          console.error(`[cf] solveChallenge failed for ${url}: ${(err as Error).message}`);
          throw err;
        }
      });

      if (clearance) console.error(`[cf] cf_clearance obtained (${clearance.slice(0, 8)}...).`);
    }

    const retried = await tryFetch(page, url, init);

    if (retried === null || isChallenge(retried) || isBlocked(retried.content)) {
      throw new Error(`cfFetch: fetch failed for ${url} even after session recovery.`);
    }

    pageCache.set(cacheKey, retried.content);
    return retried.content;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cf] recycling page for ${url} after failure: ${message}`);
    recyclePage(page);
    throw err;
  }
}

export async function closeBrowser(): Promise<void> {
  await discardSession();
}
