#!/usr/bin/env node

/**
 * Torznab-compatible server for scraper-unfriendly torrent trackers, for
 * use as "Torznab (Custom)" indexers in Prowlarr. One indexer per tracker,
 * all served from this one process (shared browser session pool + cache).
 *
 * Add a tracker: create providers/<id>.ts exporting
 * { id, name, search(q), resolveMagnet({ id, url }) } (see providers/ for
 * examples), then register it in providers/index.ts.
 *
 * Each provider gets its own Torznab endpoint at /<provider-id>/api, e.g.:
 *   http://localhost:9117/ext-to/api
 *   http://localhost:9117/1337x/api
 *
 * Usage:
 *   API_KEY=yoursecret PORT=9117 node server.js
 */

import express, { type Application, type Request, type Response } from 'express';
import { closeBrowser, gotoCleared } from './lib/browser.js';
import { categoriesXml } from './lib/categories.js';
import { TTLCache } from './lib/cache.js';
import { ProviderStatusTracker, renderStatusPage } from './lib/status.js';
import { providerMap } from './providers/index.js';
import type { MagnetRef, Provider, SearchItem, SearchOptions, SearchResult } from './lib/types.js';

const PORT = process.env.PORT || 9117;
const API_KEY = process.env.API_KEY || 'changeme';

// Solving a challenge takes ~20-30s. Landing that inside a Prowlarr search
// risks the search timing out, so a background task periodically visits each
// provider to keep its Cloudflare clearance warm and move that cost off the
// request path. It only *solves* when actually challenged - with a valid
// cookie the visit is cheap.
//
// The interval is a guess: the real clearance lifetime was never measured,
// only estimated at roughly 15-30 min. Tune with the env var, 0 disables.
const KEEPALIVE_INTERVAL_MS = process.env.KEEPALIVE_INTERVAL_MS === undefined
  ? 15 * 60 * 1000
  : Number(process.env.KEEPALIVE_INTERVAL_MS);

// Search results change (new uploads, seed counts) so keep the cache short.
// Magnet info hashes never change for a given torrent, so cache those much
// longer - avoids hitting the tracker again if Prowlarr re-grabs/retries.
const SEARCH_CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MS) || 5 * 60 * 1000;
const MAGNET_CACHE_TTL_MS = Number(process.env.MAGNET_CACHE_TTL_MS) || 60 * 60 * 1000;

// Advertised in caps' <limits> and enforced on every search - Torznab: "the
// service should automatically limit the value to the maximum".
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// Express 5's req.query values are `string | string[] | ParsedQs | ParsedQs[]
// | undefined` (from the `qs` package) - our params are always plain single
// strings, so this narrows that down in one place rather than at every call
// site.
function queryString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function xmlEscape(str: unknown): string {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  };
  return String(str).replace(/[&<>"']/g, (c) => entities[c] as string);
}

// Newznab/Torznab error convention: a well-formed <error> document, not a
// raw HTTP status. HTTP stays 200 - the error is communicated entirely via
// the code/description attributes, which is what real newznab/torznab
// clients (and Prowlarr) parse. Codes follow the standard newznab table:
// 100 auth, 200 missing parameter, 201 incorrect parameter, 203 no such
// function, 900 unknown/internal error.
function sendError(res: Response, code: number, description: string): void {
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<error code="${code}" description="${xmlEscape(description)}" />`);
}

function capsXml(provider: Provider): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="${xmlEscape(provider.name)}" strapline="${xmlEscape(provider.name)} Torznab proxy" />
  <limits max="${MAX_LIMIT}" default="${DEFAULT_LIMIT}" />
  <searching>
    <search available="yes" supportedParams="q" />
    <tv-search available="yes" supportedParams="q" />
    <movie-search available="yes" supportedParams="q" />
  </searching>
  <categories>
${categoriesXml(provider.categories)}
  </categories>
</caps>`;
}

export interface AppOptions {
  apiKey?: string;
  searchCacheTtlMs?: number;
  magnetCacheTtlMs?: number;
  // Shared with the keep-alive scheduler in production (see the isMain
  // block at the bottom) so a provider's status reflects both background
  // checks and real requests. Tests can inject their own to assert on it
  // directly; otherwise each app gets its own, independent instance.
  statusTracker?: ProviderStatusTracker;
}

// Factory rather than a module-level app: lets tests inject a fake
// providerMap and a fresh pair of caches per test instead of sharing the
// real, module-level providers/caches (and, as a side effect, avoids
// app.listen()/process signal handlers running just by importing this file
// - see the entrypoint guard at the bottom).
export function createApp(providers: Record<string, Provider>, opts: AppOptions = {}): Application {
  const apiKey = opts.apiKey ?? API_KEY;
  const searchCache = new TTLCache<SearchResult>(opts.searchCacheTtlMs ?? SEARCH_CACHE_TTL_MS);
  const magnetCache = new TTLCache<string>(opts.magnetCacheTtlMs ?? MAGNET_CACHE_TTL_MS);
  const statusTracker = opts.statusTracker ?? new ProviderStatusTracker();

  function checkKey(req: Request, res: Response): boolean {
    if (queryString(req.query.apikey) !== apiKey) {
      sendError(res, 100, 'Incorrect user credentials');
      return false;
    }
    return true;
  }

  // A blank q (Prowlarr's Test button, and every routine RSS/search sync -
  // both look identical at the HTTP level, there's no reliable way to tell
  // them apart) used to get a canned keyword substituted in. That meant
  // Sonarr/Radarr's routine automatic discovery never saw real, fresh
  // content - only whatever that fixed keyword happened to match, forever.
  // Blank q now passes straight through unchanged; each provider decides
  // what it means (return latest uploads) instead of server.ts injecting a
  // keyword. See NOTES.md for the full history of why this existed and why
  // it was removed.
  async function search(provider: Provider, q: string, opts: SearchOptions): Promise<SearchResult & { cached: boolean }> {
    // Sorted so cat=2000,5000 and cat=5000,2000 hit the same cache entry.
    const catKey = opts.categories?.length ? [...opts.categories].sort((a, b) => a - b).join(',') : '';
    const cacheKey = `${provider.id}:${q.toLowerCase().trim()}:${catKey}:${opts.offset}:${opts.limit}`;
    const cachedResult = searchCache.get(cacheKey);
    if (cachedResult) {
      console.error(`[cache] search hit for ${provider.id} q=${JSON.stringify(q)}`);
      return { ...cachedResult, cached: true };
    }

    const result = await provider.search(q, opts);
    // Never cache an empty result. A transient failure (proxy down,
    // challenge not cleared, markup change) would otherwise be frozen in
    // for the full TTL and keep being served after the underlying problem
    // is fixed.
    if (result.items.length) searchCache.set(cacheKey, result);
    return { ...result, cached: false };
  }

  async function resolveMagnet(provider: Provider, ref: MagnetRef): Promise<{ magnet: string; cached: boolean }> {
    const cacheKey = `${provider.id}:${ref.id ?? ref.url}`;
    const cachedMagnet = magnetCache.get(cacheKey);
    if (cachedMagnet) {
      console.error(`[cache] magnet hit for ${provider.id} ${JSON.stringify(ref)}`);
      return { magnet: cachedMagnet, cached: true };
    }

    const magnet = await provider.resolveMagnet(ref);
    magnetCache.set(cacheKey, magnet);
    return { magnet, cached: false };
  }

  function buildRss(req: Request, provider: Provider, items: SearchItem[], total: number): string {
    const selfUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const rows = items
      .map((it) => {
        const downloadUrl =
          `${req.protocol}://${req.get('host')}/${provider.id}/download?apikey=${encodeURIComponent(apiKey)}` +
          (it.id != null ? `&id=${it.id}` : '') +
          `&url=${encodeURIComponent(it.detailUrl)}`;
        const peers = it.seeds + it.leechers;
        return `  <item>
    <title>${xmlEscape(it.title)}</title>
    <guid isPermaLink="true">${xmlEscape(it.detailUrl)}</guid>
    <comments>${xmlEscape(it.detailUrl)}</comments>
    <pubDate>${it.pubDate.toUTCString()}</pubDate>
    <size>${it.size}</size>
    <link>${xmlEscape(downloadUrl)}</link>
    <category>${it.category}</category>
    <enclosure url="${xmlEscape(downloadUrl)}" length="${it.size}" type="application/x-bittorrent" />
    <torznab:attr name="category" value="${it.category}" />
    <torznab:attr name="size" value="${it.size}" />
    <torznab:attr name="seeders" value="${it.seeds}" />
    <torznab:attr name="peers" value="${peers}" />
  </item>`;
      })
      .join('\n');

    // total is spec-compliance polish, not load-bearing: Prowlarr itself
    // never parses opensearch:totalResults (confirmed from its source).
    // What actually stops its pagination is items.length coming back
    // shorter than the requested limit - see lib/paging.ts.
    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
<channel>
  <atom:link href="${xmlEscape(selfUrl)}" rel="self" type="application/rss+xml" />
  <title>${xmlEscape(provider.name)}</title>
  <opensearch:totalResults>${total}</opensearch:totalResults>
  <opensearch:itemsPerPage>${items.length}</opensearch:itemsPerPage>
${rows}
</channel>
</rss>`;
  }

  const app = express();

  // No apikey needed - same reasoning as ?t=caps: this exposes no torrent
  // data and lets you do nothing, it's just a health dashboard meant to be
  // pulled up directly in a browser.
  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(renderStatusPage(providers, statusTracker));
  });

  function getProvider(req: Request, res: Response): Provider | null {
    const provider = providers[req.params.provider as string];
    if (!provider) {
      res.status(404).send(`Unknown provider: ${req.params.provider}`);
      return null;
    }
    return provider;
  }

  app.get('/:provider/api', async (req: Request, res: Response) => {
    const provider = getProvider(req, res);
    if (!provider) return;

    const t = queryString(req.query.t);

    if (t === 'caps') {
      res.type('application/xml').send(capsXml(provider));
      return;
    }

    if (!checkKey(req, res)) return;

    // Torznab function names are unhyphenated (t=search/tvsearch/movie) -
    // the hyphenated forms are only the caps <tv-search>/<movie-search>
    // *element* names, a different thing.
    if (t === 'search' || t === 'tvsearch' || t === 'movie') {
      const q = queryString(req.query.q) || '';
      const catParam = queryString(req.query.cat);
      // Comma-separated, OR'd (cat=2000,5000 -> either). Unknown/unparseable
      // entries are silently dropped, not an error.
      const categories = catParam
        ? catParam
            .split(',')
            .map((c) => parseInt(c.trim(), 10))
            .filter((n) => !Number.isNaN(n))
        : undefined;
      // Spec: both must be integers >= 0, otherwise error 201 - not a
      // silent fallback. Empty/absent is fine and defaults normally.
      const offsetParam = queryString(req.query.offset);
      let offset = 0;
      if (offsetParam) {
        const parsed = Number(offsetParam);
        if (!Number.isInteger(parsed) || parsed < 0) {
          sendError(res, 201, 'Incorrect parameter: offset must be a non-negative integer');
          return;
        }
        offset = parsed;
      }
      const limitParam = queryString(req.query.limit);
      let limit = DEFAULT_LIMIT;
      if (limitParam) {
        const parsed = Number(limitParam);
        if (!Number.isInteger(parsed) || parsed < 0) {
          sendError(res, 201, 'Incorrect parameter: limit must be a non-negative integer');
          return;
        }
        limit = parsed;
      }
      limit = Math.min(limit, MAX_LIMIT);

      try {
        const { items, total, cached } = await search(provider, q, { categories, offset, limit });
        statusTracker.recordRequest(provider.id, true, { cached });
        res.type('application/xml').send(buildRss(req, provider, items, total));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        statusTracker.recordRequest(provider.id, false, { error: message });
        console.error(`${provider.id} search error:`, err);
        sendError(res, 900, `Search failed: ${message}`);
      }
      return;
    }

    sendError(res, 203, `Function not available: t=${t}`);
  });

  app.get('/:provider/download', async (req: Request, res: Response) => {
    const provider = getProvider(req, res);
    if (!provider) return;

    if (!checkKey(req, res)) return;

    const idParam = queryString(req.query.id);
    const id = idParam ? parseInt(idParam, 10) : null;
    const url = queryString(req.query.url) || null;
    if (!id && !url) {
      sendError(res, 200, 'Missing parameter: id or url');
      return;
    }

    try {
      const { magnet, cached } = await resolveMagnet(provider, { id, url });
      statusTracker.recordRequest(provider.id, true, { cached });
      res.redirect(302, magnet);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      statusTracker.recordRequest(provider.id, false, { error: message });
      console.error(`${provider.id} download error:`, err);
      sendError(res, 900, `Download failed: ${message}`);
    }
  });

  return app;
}

// Visits a provider's keep-alive URL so its clearance cookie stays fresh.
// gotoCleared() already solves only when challenged, so this is cheap while
// the cookie is still valid.
async function warmProvider(provider: Provider, statusTracker: ProviderStatusTracker): Promise<void> {
  const ka = provider.keepAlive;
  if (!ka) return;
  const started = Date.now();
  try {
    const page = await gotoCleared(ka.url, ka.proxy ? { proxy: ka.proxy } : {});
    await page.close();
    statusTracker.recordCheck(provider.id, true);
    console.error(`[keepalive] ${provider.id} ok (${Date.now() - started}ms)`);
  } catch (err) {
    // Never throw: a tracker being unreachable must not kill the scheduler.
    const message = err instanceof Error ? err.message : String(err);
    statusTracker.recordCheck(provider.id, false, message);
    console.error(`[keepalive] ${provider.id} failed: ${message}`);
  }
}

let keepAliveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleKeepAlive(statusTracker: ProviderStatusTracker): void {
  if (!KEEPALIVE_INTERVAL_MS) {
    console.log('Keep-alive disabled (KEEPALIVE_INTERVAL_MS=0)');
    return;
  }
  console.log(`Keep-alive every ~${Math.round(KEEPALIVE_INTERVAL_MS / 60000)} min`);

  const tick = async () => {
    // Sequential, not parallel: solves are serialised anyway (XTEST input is
    // global), and this keeps at most one browser page open at a time.
    for (const provider of Object.values(providerMap)) {
      await warmProvider(provider, statusTracker);
    }
    // +/-20% jitter, so we're not hitting the trackers on an exact schedule.
    const next = KEEPALIVE_INTERVAL_MS * (0.8 + Math.random() * 0.4);
    keepAliveTimer = setTimeout(tick, next);
  };

  // Warm shortly after boot so the first real search doesn't pay for a solve.
  keepAliveTimer = setTimeout(tick, 5000);
}

async function shutdown(): Promise<void> {
  console.log('Shutting down, closing browser...');
  if (keepAliveTimer) clearTimeout(keepAliveTimer);
  await closeBrowser();
  process.exit(0);
}

// Only actually start listening (and register process-level signal handlers)
// when this file is run directly - e.g. `node dist/server.js`, which is what
// the Dockerfile's CMD does. Importing createApp() from a test must not have
// these side effects.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  // Shared between the app's routes and the keep-alive scheduler, so the
  // status page reflects both real requests and background checks.
  const statusTracker = new ProviderStatusTracker();
  const app = createApp(providerMap, { statusTracker });
  app.listen(PORT, () => {
    console.log(`Torznab server listening on http://localhost:${PORT}`);
    console.log(`  status page: http://localhost:${PORT}/`);
    for (const provider of Object.values(providerMap)) {
      console.log(`  ${provider.name}: http://localhost:${PORT}/${provider.id}/api`);
    }
    console.log(`API key: ${API_KEY}${API_KEY === 'changeme' ? ' (set API_KEY env var to something real!)' : ''}`);
    scheduleKeepAlive(statusTracker);
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
