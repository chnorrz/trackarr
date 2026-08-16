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
import { CATEGORIES_XML } from './lib/categories.js';
import { TTLCache } from './lib/cache.js';
import { providerMap } from './providers/index.js';
import type { MagnetRef, Provider, SearchItem } from './lib/types.js';

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

function capsXml(provider: Provider): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="${xmlEscape(provider.name)}" strapline="${xmlEscape(provider.name)} Torznab proxy" />
  <limits max="100" default="50" />
  <searching>
    <search available="yes" supportedParams="q" />
    <movie-search available="yes" supportedParams="q" />
    <tv-search available="yes" supportedParams="q" />
  </searching>
  <categories>
${CATEGORIES_XML}
  </categories>
</caps>`;
}

export interface AppOptions {
  apiKey?: string;
  searchCacheTtlMs?: number;
  magnetCacheTtlMs?: number;
}

// Factory rather than a module-level app: lets tests inject a fake
// providerMap and a fresh pair of caches per test instead of sharing the
// real, module-level providers/caches (and, as a side effect, avoids
// app.listen()/process signal handlers running just by importing this file
// - see the entrypoint guard at the bottom).
export function createApp(providers: Record<string, Provider>, opts: AppOptions = {}): Application {
  const apiKey = opts.apiKey ?? API_KEY;
  const searchCache = new TTLCache<SearchItem[]>(opts.searchCacheTtlMs ?? SEARCH_CACHE_TTL_MS);
  const magnetCache = new TTLCache<string>(opts.magnetCacheTtlMs ?? MAGNET_CACHE_TTL_MS);

  function checkKey(req: Request, res: Response): boolean {
    if (queryString(req.query.apikey) !== apiKey) {
      res.status(401).send('Invalid apikey');
      return false;
    }
    return true;
  }

  async function search(provider: Provider, q: string): Promise<SearchItem[]> {
    // Prowlarr's "Test" button (and likely periodic health checks) queries
    // with an empty q, and requires a non-empty result set to let the
    // indexer be saved - an empty-but-valid response isn't enough
    // (confirmed: Save fails with a red exclamation mark otherwise). No
    // provider has a real "browse everything" mode for a blank query, so
    // substitute a term proven to return results for THIS SPECIFIC
    // provider, rather than either returning nothing (which Prowlarr
    // rejects) or fabricating a fake item (which would fail differently
    // and more confusingly the moment anything tried to resolve its
    // magnet link).
    //
    // This must be per-provider, not a single shared default: 'yify' is a
    // movie-release-group tag with zero hits on a TV-only tracker like
    // EZTV, which silently reproduced the exact same Prowlarr "no results"
    // failure this substitution was meant to fix in the first place (see
    // NOTES.md - this class of bug is why testQuery is checked before
    // shipping a new provider now, not just assumed to inherit a working
    // default).
    if (!q || !q.trim()) {
      if (!provider.testQuery) {
        console.error(`[warn] ${provider.id} has no testQuery set, falling back to '' (empty) - verify this actually returns results for this provider.`);
      }
      q = provider.testQuery || '';
    }

    const cacheKey = `${provider.id}:${q.toLowerCase().trim()}`;
    const cached = searchCache.get(cacheKey);
    if (cached) {
      console.error(`[cache] search hit for ${provider.id} q=${JSON.stringify(q)}`);
      return cached;
    }

    const items = await provider.search(q);
    // Never cache an empty result. A transient failure (proxy down,
    // challenge not cleared, markup change) would otherwise be frozen in
    // for the full TTL and keep being served after the underlying problem
    // is fixed.
    if (items.length) searchCache.set(cacheKey, items);
    return items;
  }

  async function resolveMagnet(provider: Provider, ref: MagnetRef): Promise<string> {
    const cacheKey = `${provider.id}:${ref.id ?? ref.url}`;
    const cached = magnetCache.get(cacheKey);
    if (cached) {
      console.error(`[cache] magnet hit for ${provider.id} ${JSON.stringify(ref)}`);
      return cached;
    }

    const magnet = await provider.resolveMagnet(ref);
    magnetCache.set(cacheKey, magnet);
    return magnet;
  }

  function buildRss(req: Request, provider: Provider, items: SearchItem[]): string {
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

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed">
<channel>
  <atom:link href="${xmlEscape(selfUrl)}" rel="self" type="application/rss+xml" />
  <title>${xmlEscape(provider.name)}</title>
${rows}
</channel>
</rss>`;
  }

  const app = express();

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

    if (t === 'search' || t === 'movie-search' || t === 'tv-search') {
      const q = queryString(req.query.q) || '';
      try {
        const items = await search(provider, q);
        res.type('application/xml').send(buildRss(req, provider, items));
      } catch (err) {
        console.error(`${provider.id} search error:`, err);
        res.status(500).send(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    res.status(400).send(`Unsupported t=${t}`);
  });

  app.get('/:provider/download', async (req: Request, res: Response) => {
    const provider = getProvider(req, res);
    if (!provider) return;

    if (!checkKey(req, res)) return;

    const idParam = queryString(req.query.id);
    const id = idParam ? parseInt(idParam, 10) : null;
    const url = queryString(req.query.url) || null;
    if (!id && !url) {
      res.status(400).send('Missing id or url param');
      return;
    }

    try {
      const magnet = await resolveMagnet(provider, { id, url });
      res.redirect(302, magnet);
    } catch (err) {
      console.error(`${provider.id} download error:`, err);
      res.status(500).send(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return app;
}

// Visits a provider's keep-alive URL so its clearance cookie stays fresh.
// gotoCleared() already solves only when challenged, so this is cheap while
// the cookie is still valid.
async function warmProvider(provider: Provider): Promise<void> {
  const ka = provider.keepAlive;
  if (!ka) return;
  const started = Date.now();
  try {
    const page = await gotoCleared(ka.url, ka.proxy ? { proxy: ka.proxy } : {});
    await page.close();
    console.error(`[keepalive] ${provider.id} ok (${Date.now() - started}ms)`);
  } catch (err) {
    // Never throw: a tracker being unreachable must not kill the scheduler.
    console.error(`[keepalive] ${provider.id} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let keepAliveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleKeepAlive(): void {
  if (!KEEPALIVE_INTERVAL_MS) {
    console.log('Keep-alive disabled (KEEPALIVE_INTERVAL_MS=0)');
    return;
  }
  console.log(`Keep-alive every ~${Math.round(KEEPALIVE_INTERVAL_MS / 60000)} min`);

  const tick = async () => {
    // Sequential, not parallel: solves are serialised anyway (XTEST input is
    // global), and this keeps at most one browser page open at a time.
    for (const provider of Object.values(providerMap)) {
      await warmProvider(provider);
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
  const app = createApp(providerMap);
  app.listen(PORT, () => {
    console.log(`Torznab server listening on http://localhost:${PORT}`);
    for (const provider of Object.values(providerMap)) {
      console.log(`  ${provider.name}: http://localhost:${PORT}/${provider.id}/api`);
    }
    console.log(`API key: ${API_KEY}${API_KEY === 'changeme' ? ' (set API_KEY env var to something real!)' : ''}`);
    scheduleKeepAlive();
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
