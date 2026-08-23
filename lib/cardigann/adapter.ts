import { buildMagnetFromInfohash, resolveCardigannDownload, type Fetcher } from './download.js';
import { collectCategoryMappings } from './category-mapping.js';
import { categoryIdByName, categoryNameById } from '../categories.js';
import type { IndexerConfigEntry } from './config.js';
import { runSearchAll, type CardigannItem } from './engine.js';
import { applyFilters, type FilterSpec } from './filters.js';
import { buildPathRequests, type SearchBlockForPaths } from './paths.js';
import type { ResolvedDefinition } from './resolve.js';
import type { TemplateContext } from './template.js';
import type { MagnetRef, Provider, SearchItem, SearchOptions, SearchResult } from '../types.js';

// Ties every lib/cardigann module together into a real Provider: fetches
// aren't made here directly, they go through an injected Fetcher (real
// callers pass cfFetch; tests inject a fake) so this module stays free of
// browser/network concerns, same discipline as the rest of lib/cardigann.
//
// Known, deliberate limitations (see NOTES.md section 20 for the full list):
//  - .Query.* only carries Type/Q/Keywords/Categories/Offset/Limit - our own
//    server.ts doesn't parse season/ep/imdbid/tvdbid/etc from the request at
//    all yet, so a definition referencing those always sees "".
//  - SearchPathBlock.response (a per-path response-type override) is not
//    respected; the top-level search.response.type is used for every path.
//  - A single path's fetch failure fails the whole search; no partial
//    degrade to whichever paths did succeed.

export interface ResolvedIndexerLike {
  key: string;
  entry: IndexerConfigEntry;
  resolved: ResolvedDefinition;
}

export interface CreateCardigannProviderOptions {
  fetch: Fetcher;
  /** Injectable so tests with a nonzero requestDelay don't really wait. */
  sleep?: (ms: number) => Promise<void>;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function resolveUrl(raw: string, base: string): string {
  if (!raw) return base;
  try {
    return new URL(raw, base).toString();
  } catch {
    return raw;
  }
}

function directMagnet(item: CardigannItem): string | undefined {
  if (item.magnet?.startsWith('magnet:')) return item.magnet;
  if (item.download?.startsWith('magnet:')) return item.download;
  if (item.infohash) return buildMagnetFromInfohash(item.infohash, item.title);
  return undefined;
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Every HTTP call this provider instance makes (search paths, download
// before/selectors sub-fetches, a resolveMagnet cache-miss fallback) goes
// through this one gate, so requestDelay (definition-level, seconds) is
// honoured consistently rather than only on the initial search request.
function createGatedFetch(rawFetch: Fetcher, requestDelaySec: number, sleep: (ms: number) => Promise<void>): Fetcher {
  if (!requestDelaySec) return rawFetch;
  let lastAt = 0;
  return async (url, opts) => {
    const wait = lastAt + requestDelaySec * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    return rawFetch(url, opts);
  };
}

export function createCardigannProvider(indexer: ResolvedIndexerLike, opts: CreateCardigannProviderOptions): Provider {
  const { key, entry, resolved } = indexer;
  const definition = resolved.definition;

  const links = Array.isArray(definition.links) ? (definition.links as string[]) : [];
  const baseUrl: string =
    entry.link ??
    links[0] ??
    (() => {
      throw new Error(`cardigann: "${key}" (${resolved.definitionId}) has no links[] and no config link: override`);
    })();

  const requestDelaySec = Number(definition.requestDelay) || 0;
  const gatedFetch = createGatedFetch(opts.fetch, requestDelaySec, opts.sleep ?? defaultSleep);

  const config: Record<string, string> = {};
  for (const [k, v] of Object.entries(entry.config ?? {})) config[k] = String(v);

  const mappings = collectCategoryMappings(definition);
  const advertisedCategories = [...new Set(mappings.map((m) => categoryIdByName(m.standardName)))];

  // Bounded, no TTL - matches providers/eztv.ts's own magnetCache exactly
  // (magnets don't go stale the way page content does).
  const MAGNET_CACHE_MAX = 500;
  const magnetCache = new Map<string, string>();
  function rememberMagnet(url: string, magnet: string): void {
    if (magnetCache.size >= MAGNET_CACHE_MAX) {
      const oldest = magnetCache.keys().next().value;
      if (oldest !== undefined) magnetCache.delete(oldest);
    }
    magnetCache.set(url, magnet);
  }

  async function search(q: string, searchOpts: SearchOptions): Promise<SearchResult> {
    const searchBlock = asRecord(definition.search) as unknown as SearchBlockForPaths;
    const keywordsFilters = Array.isArray((definition.search as Record<string, unknown> | undefined)?.keywordsfilters)
      ? ((definition.search as Record<string, unknown>).keywordsfilters as FilterSpec[])
      : [];
    const keywords = applyFilters(keywordsFilters, q);

    // .Categories: requested numeric Torznab ids -> this tracker's own
    // native category ids, via the standard-name each side agrees on.
    const requestedNative = new Set<string>();
    for (const id of searchOpts.categories ?? []) {
      const name = categoryNameById(id);
      if (!name) continue;
      for (const m of mappings) if (m.standardName === name) requestedNative.add(m.trackerId);
    }
    const categoriesForCtx = [...requestedNative];

    const ctx: TemplateContext = {
      Keywords: keywords,
      Query: {
        Type: 'search',
        Q: q,
        Keywords: q,
        Categories: (searchOpts.categories ?? []).join(','),
        Offset: String(searchOpts.offset),
        Limit: String(searchOpts.limit)
      },
      Categories: categoriesForCtx,
      Config: config,
      Result: {}
    };

    const requests = buildPathRequests(searchBlock, baseUrl, ctx);
    const allItems: CardigannItem[] = [];
    for (const req of requests) {
      const body = await gatedFetch(req.url, { method: req.method, headers: req.headers, body: req.body });
      const items = runSearchAll(definition, body, {
        keywords,
        categories: categoriesForCtx,
        offset: 0,
        limit: Number.MAX_SAFE_INTEGER,
        config,
        query: ctx.Query
      });
      allItems.push(...items);
    }

    // Cardigann definitions don't filter server-side beyond a path's own
    // categories restriction (paths.ts) - apply the caller's category
    // filter here, same as our hand-written providers' own `filter` step.
    const filtered =
      searchOpts.categories && searchOpts.categories.length > 0
        ? allItems.filter((it) => searchOpts.categories?.includes(categoryIdByName(it.category)))
        : allItems;

    const page = filtered.slice(searchOpts.offset, searchOpts.offset + searchOpts.limit);

    const searchItems: SearchItem[] = page.map((it) => {
      const detailUrl = resolveUrl(it.detailUrl, baseUrl);
      const magnet = directMagnet(it);
      if (magnet) rememberMagnet(detailUrl, magnet);

      return {
        title: it.title,
        detailUrl,
        id: null,
        size: it.size,
        seeds: it.seeds,
        leechers: it.leechers,
        category: categoryIdByName(it.category),
        pubDate: it.pubDate
      };
    });

    return { items: searchItems, total: filtered.length };
  }

  async function resolveMagnet({ url }: MagnetRef): Promise<string> {
    if (!url) throw new Error(`${key}: resolveMagnet requires a url.`);

    const cached = magnetCache.get(url);
    if (cached) return cached;

    // Cache miss: the original item's title/download-field are gone by now
    // (MagnetRef only carries id/url) - fall back to re-deriving a magnet
    // from the detail page itself, same trade-off our hand-written
    // providers make on their own cache-miss path.
    const magnet = await resolveCardigannDownload({ definition, downloadUri: url, itemTitle: '', fetch: gatedFetch });
    rememberMagnet(url, magnet);
    return magnet;
  }

  return {
    id: key,
    name: String(definition.name ?? key),
    keepAlive: { url: baseUrl },
    categories: advertisedCategories,
    search,
    resolveMagnet
  };
}
