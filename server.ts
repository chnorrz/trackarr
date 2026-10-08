#!/usr/bin/env node

import express, { type Application, type Request, type Response } from 'express';
import { closeBrowser, cfFetch } from './lib/browser.js';
import { categoriesXml } from './lib/categories.js';
import { TTLCache } from './lib/cache.js';
import { getCamoufoxMemoryUsage, type CamoufoxMemoryUsage } from './lib/processStats.js';
import { ProviderStatusTracker, buildStatusJson, renderStatusPage } from './lib/status.js';
import { buildProviderMap } from './providers/index.js';
import type { MagnetRef, Provider, ResolvedDownload, SearchItem, SearchMode } from './lib/types.js';

const PORT = process.env.PORT || 9117;
const API_KEY = process.env.API_KEY || 'changeme';

// Real Cloudflare clearance lifetime was never measured, only estimated at
// ~15-30 min, so this interval is a guess. 0 disables.
const KEEPALIVE_INTERVAL_MS = process.env.KEEPALIVE_INTERVAL_MS === undefined
  ? 15 * 60 * 1000
  : Number(process.env.KEEPALIVE_INTERVAL_MS);

const MAGNET_CACHE_TTL_MS = Number(process.env.MAGNET_CACHE_TTL_MS) || 60 * 60 * 1000;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

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

// Newznab/Torznab convention: errors are an <error> document sent with HTTP
// 200, not an HTTP error status - that is what Prowlarr parses.
function sendError(res: Response, code: number, description: string): void {
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<error code="${code}" description="${xmlEscape(description)}" />`);
}

// Torznab convention (confirmed against Prowlarr's own IndexerCapabilities.cs):
// every element is always present, available="no" for an unsupported mode -
// not omitted. music (Cardigann's own caps.modes key: music-search) renders
// as <audio-search> - Newznab's own naming mismatch, not ours.
const ALL_MODES: readonly SearchMode[] = ['search', 'tvsearch', 'movie', 'music', 'book'];
const MODE_ELEMENT: Record<SearchMode, string> = {
  search: 'search',
  tvsearch: 'tv-search',
  movie: 'movie-search',
  music: 'audio-search',
  book: 'book-search'
};

function isSearchMode(t: string | undefined): t is SearchMode {
  return t !== undefined && (ALL_MODES as readonly string[]).includes(t);
}

function capsXml(provider: Provider): string {
  const supported = new Set(provider.searchModes);
  const searching = ALL_MODES
    .map((mode) => {
      const params = provider.searchParams[mode] ?? ['q'];
      return `    <${MODE_ELEMENT[mode]} available="${supported.has(mode) ? 'yes' : 'no'}" supportedParams="${params.join(',')}" />`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="${xmlEscape(provider.name)}" strapline="${xmlEscape(provider.name)} Torznab proxy" />
  <limits max="${MAX_LIMIT}" default="${DEFAULT_LIMIT}" />
  <searching>
${searching}
  </searching>
  <categories>
${categoriesXml(provider.categories)}
  </categories>
</caps>`;
}

export interface AppOptions {
  apiKey?: string;
  magnetCacheTtlMs?: number;
  statusTracker?: ProviderStatusTracker;
  getCamoufoxMemoryUsage?: () => Promise<CamoufoxMemoryUsage>;
}

export function createApp(providers: Record<string, Provider>, opts: AppOptions = {}): Application {
  const apiKey = opts.apiKey ?? API_KEY;
  const magnetCache = new TTLCache<ResolvedDownload>(opts.magnetCacheTtlMs ?? MAGNET_CACHE_TTL_MS);
  const statusTracker = opts.statusTracker ?? new ProviderStatusTracker();
  const camoufoxMemoryUsage = opts.getCamoufoxMemoryUsage ?? getCamoufoxMemoryUsage;

  function checkKey(req: Request, res: Response): boolean {
    if (queryString(req.query.apikey) !== apiKey) {
      sendError(res, 100, 'Incorrect user credentials');
      return false;
    }
    return true;
  }

  async function resolveMagnet(provider: Provider, ref: MagnetRef): Promise<{ resolved: ResolvedDownload; cached: boolean }> {
    const cacheKey = `${provider.id}:${ref.url}`;
    const cachedResolved = magnetCache.get(cacheKey);
    if (cachedResolved) {
      console.error(`[cache] magnet hit for ${provider.id} ${JSON.stringify(ref)}`);
      return { resolved: cachedResolved, cached: true };
    }

    const resolved = await provider.resolveMagnet(ref);
    // Only cache a magnet: a .torrent file's bytes are fetched fresh and
    // streamed straight through below, not cached here - same reasoning as
    // adapter.ts's own magnetCache (a one-shot download, not worth the
    // memory to hold onto).
    if (resolved.kind === 'magnet') magnetCache.set(cacheKey, resolved);
    return { resolved, cached: false };
  }

  function buildRss(req: Request, provider: Provider, items: SearchItem[], total: number): string {
    const selfUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const rows = items
      .map((it) => {
        const downloadUrl =
          `${req.protocol}://${req.get('host')}/${provider.id}/download?apikey=${encodeURIComponent(apiKey)}` +
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

  app.use((req: Request, _res: Response, next) => {
    const url = req.originalUrl.replace(/([?&]apikey=)[^&]*/, '$1***');
    const ua = req.get('user-agent') || 'unknown';
    console.error(`[req] ${req.ip} "${ua}" ${req.method} ${url}`);
    next();
  });

  app.get('/', (_req: Request, res: Response) => {
    res.type('html').send(renderStatusPage(providers, statusTracker));
  });

  app.get('/status.json', async (_req: Request, res: Response) => {
    const camoufox = await camoufoxMemoryUsage();
    res.json(buildStatusJson(providers, statusTracker, camoufox));
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

    if (isSearchMode(t)) {
      if (!provider.searchModes.includes(t)) {
        sendError(res, 203, `Function not available: t=${t}`);
        return;
      }

      const q = queryString(req.query.q) || '';
      const season = queryString(req.query.season);
      const ep = queryString(req.query.ep);
      const catParam = queryString(req.query.cat);
      if (catParam && !/^\d+(,\d+)*$/.test(catParam)) {
        sendError(res, 201, 'Incorrect parameter: cat must be a comma-separated list of non-negative integers');
        return;
      }
      const categories = catParam ? catParam.split(',').map((c) => parseInt(c, 10)) : undefined;
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
        const { items, total } = await provider.search(q, { categories, offset, limit, type: t, season, ep });
        statusTracker.recordRequest(provider.id, true);
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

    const url = queryString(req.query.url);
    if (!url) {
      sendError(res, 200, 'Missing parameter: url');
      return;
    }

    try {
      const { resolved, cached } = await resolveMagnet(provider, { url });
      statusTracker.recordRequest(provider.id, true, { cached });
      if (resolved.kind === 'magnet') {
        res.redirect(302, resolved.magnet);
      } else {
        // A real .torrent file: already fetched server-side (through the
        // same Cloudflare-bypassed session a downstream client couldn't
        // manage on its own), so the bytes are sent directly - not a
        // redirect, which would just hand the client a URL it can't reach.
        res.type('application/x-bittorrent');
        res.set('Content-Disposition', `attachment; filename="${resolved.filename.replace(/"/g, '')}"`);
        res.send(resolved.data);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      statusTracker.recordRequest(provider.id, false, { error: message });
      console.error(`${provider.id} download error:`, err);
      sendError(res, 900, `Download failed: ${message}`);
    }
  });

  return app;
}

async function warmProvider(provider: Provider, statusTracker: ProviderStatusTracker): Promise<void> {
  const ka = provider.keepAlive;
  if (!ka) return;
  const started = Date.now();
  try {
    await cfFetch(ka.url);
    statusTracker.recordCheck(provider.id, true);
    console.error(`[keepalive] ${provider.id} ok (${Date.now() - started}ms)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    statusTracker.recordCheck(provider.id, false, message);
    console.error(`[keepalive] ${provider.id} failed: ${message}`);
  }
}

let keepAliveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleKeepAlive(statusTracker: ProviderStatusTracker, providers: Record<string, Provider>): void {
  if (!KEEPALIVE_INTERVAL_MS) {
    console.log('Keep-alive disabled (KEEPALIVE_INTERVAL_MS=0)');
    return;
  }
  console.log(`Keep-alive every ~${Math.round(KEEPALIVE_INTERVAL_MS / 60000)} min`);

  const tick = async () => {
    // Sequential, not parallel: solves are serialised anyway (XTEST input is
    // global), and this keeps at most one browser page open at a time.
    for (const provider of Object.values(providers)) {
      await warmProvider(provider, statusTracker);
    }
    const next = KEEPALIVE_INTERVAL_MS * (0.8 + Math.random() * 0.4);
    keepAliveTimer = setTimeout(tick, next);
  };

  keepAliveTimer = setTimeout(tick, 5000);
}

async function shutdown(): Promise<void> {
  console.log('Shutting down, closing browser...');
  if (keepAliveTimer) clearTimeout(keepAliveTimer);
  await closeBrowser();
  process.exit(0);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  // Every indexer is Cardigann-driven and config-declared; a source: URL
  // needs a real fetch to resolve, so this is awaited before listen()
  // rather than built synchronously. A malformed config file throws out of
  // here and crashes the boot - see buildProviderMap()'s own doc comment.
  const providers = await buildProviderMap();
  const statusTracker = new ProviderStatusTracker();
  const app = createApp(providers, { statusTracker });
  app.listen(PORT, () => {
    console.log(`Torznab server listening on http://localhost:${PORT}`);
    console.log(`  status page: http://localhost:${PORT}/`);
    if (Object.keys(providers).length === 0) {
      console.log(`  No indexers configured - see config/trackarr.yml.example (CONFIG_FILE env var to point elsewhere).`);
    }
    for (const provider of Object.values(providers)) {
      console.log(`  ${provider.name}: http://localhost:${PORT}/${provider.id}/api`);
    }
    console.log(`API key: ${API_KEY}${API_KEY === 'changeme' ? ' (set API_KEY env var to something real!)' : ''}`);
    scheduleKeepAlive(statusTracker, providers);
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
