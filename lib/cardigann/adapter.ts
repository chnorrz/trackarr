import { buildMagnetFromInfohash, resolveCardigannDownload, type Fetcher } from './download.js';
import { collectCategoryMappings } from './category-mapping.js';
import { categoryIdByName, categoryNameById } from '../categories.js';
import { parseWithFormat } from './date-format.js';
import type { IndexerConfigEntry } from './config.js';
import { runSearchAll, type CardigannItem } from './engine.js';
import { applyFilters, type FilterSpec } from './filters.js';
import { buildPathRequests, type SearchBlockForPaths } from './paths.js';
import type { ResolvedDefinition } from './resolve.js';
import type { TemplateContext } from './template.js';
import type { MagnetRef, Provider, ResolvedDownload, SearchItem, SearchMode, SearchOptions, SearchResult } from '../types.js';

// Ties every lib/cardigann module together into a real Provider: fetches
// aren't made here directly, they go through an injected Fetcher (real
// callers pass cfFetch; tests inject a fake) so this module stays free of
// browser/network concerns, same discipline as the rest of lib/cardigann.
//
// Known, deliberate limitations (see NOTES.md section 20 for the full list):
//  - .Query.* carries Type/Q/Keywords/Season/Ep/Episode/Categories/Offset/
//    Limit - imdbid/tvdbid/tmdbid/etc are still not parsed by server.ts, so
//    a definition referencing those always sees "".
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

// Matches template.ts's own .True/.False convention (a boolean false is the
// empty string, matching Go template's "empty" truthiness for the zero
// value; true is 'True', the same literal .True itself resolves to) - not
// generic String(v), which would render false as the non-empty, therefore
// truthy, string "false". Definitions comparing a boolean setting via
// `eq .Config.x .False` (1337x.yml's disablesort) depend on this.
function configValueToString(v: string | number | boolean): string {
  if (typeof v === 'boolean') return v ? 'True' : '';
  return String(v);
}

// caps.settings[].default seeds .Config before the indexer's own config:
// overrides are applied, so a definition can reference .Config.<setting>
// and get the documented default even when the operator never set it.
function settingDefaults(definition: Record<string, unknown>): Record<string, string> {
  const settings = Array.isArray(definition.settings) ? (definition.settings as Record<string, unknown>[]) : [];
  const defaults: Record<string, string> = {};
  for (const s of settings) {
    if (typeof s.name !== 'string' || s.default === undefined) continue;
    if (typeof s.default !== 'string' && typeof s.default !== 'number' && typeof s.default !== 'boolean') continue;
    defaults[s.name] = configValueToString(s.default);
  }
  return defaults;
}

// Mirrors Prowlarr's TvSearchCriteria.GetEpisodeSearchString() exactly
// (confirmed against its own source, not guessed), so the token appended to
// Keywords for a tv-search is the same one a real Cardigann definition
// would see: "S01E02" for a standard episode, "S01" for a season pack, or
// "2024.03.27" for a daily show (season carries the air year, ep "MM/dd").
function episodeSearchString(season: string | undefined, ep: string | undefined): string {
  if (!season || Number(season) === 0) return '';

  const asDate = parseWithFormat(`${season} ${ep ?? ''}`, 'yyyy MM/dd');
  if (asDate) {
    const y = asDate.getUTCFullYear();
    const m = String(asDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(asDate.getUTCDate()).padStart(2, '0');
    return `${y}.${m}.${d}`;
  }

  const seasonToken = season.padStart(2, '0');
  if (!ep) return `S${seasonToken}`;
  const epNum = Number(ep);
  const epToken = ep !== '' && Number.isInteger(epNum) ? String(epNum).padStart(2, '0') : ep;
  return `S${seasonToken}E${epToken}`;
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
// before/selectors sub-fetches, a resolveMagnet cache-miss fallback, a
// resolved .torrent file's own bytes - all through the one Fetcher now)
// goes through this gate, so requestDelay (definition-level, seconds) is
// honoured consistently rather than only on the initial search request.
function createGatedFetch(rawFetch: Fetcher, requestDelaySec: number, sleep: (ms: number) => Promise<void>): Fetcher {
  if (!requestDelaySec) return rawFetch;
  let lastAt = 0;
  return async (url, opts) => {
    const remaining = lastAt + requestDelaySec * 1000 - Date.now();
    if (remaining > 0) await sleep(remaining);
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

  const config: Record<string, string> = { ...settingDefaults(definition) };
  for (const [k, v] of Object.entries(entry.config ?? {})) config[k] = configValueToString(v);
  // Cardigann's ".Config.sitelink" is a wiki-documented built-in, always the
  // resolved base URL - not something a user sets via indexer config, so
  // this is applied after (and can't be overridden by) the defaults/loop
  // above.
  config.sitelink = baseUrl;

  const mappings = collectCategoryMappings(definition);
  const advertisedCategories = [...new Set(mappings.map((m) => categoryIdByName(m.standardName)))];

  // caps.modes' own key names, not Torznab's t= values or caps element
  // names - both of those are SearchMode's own concern (see types.ts).
  // caps.modes.search is schema-required, so this is never empty.
  const MODE_KEYS: Record<string, SearchMode> = {
    search: 'search',
    'tv-search': 'tvsearch',
    'movie-search': 'movie',
    'music-search': 'music',
    'book-search': 'book'
  };
  const declaredModes = asRecord(asRecord(definition.caps).modes);
  const searchModes = Object.entries(MODE_KEYS)
    .filter(([capsKey]) => capsKey in declaredModes)
    .map(([, mode]) => mode);
  const searchParams: Partial<Record<SearchMode, string[]>> = {};
  for (const [capsKey, mode] of Object.entries(MODE_KEYS)) {
    const raw = declaredModes[capsKey];
    if (Array.isArray(raw)) searchParams[mode] = raw.filter((p): p is string => typeof p === 'string');
  }

  // Bounded, no TTL - magnets don't go stale the way page content does.
  const MAGNET_CACHE_MAX = 500;
  const magnetCache = new Map<string, string>();
  function rememberMagnet(url: string, magnet: string): void {
    if (magnetCache.size >= MAGNET_CACHE_MAX) {
      const oldest = magnetCache.keys().next().value;
      if (oldest !== undefined) magnetCache.delete(oldest);
    }
    magnetCache.set(url, magnet);
  }

  // MagnetRef only ever carries the item's detailUrl (server.ts builds RSS
  // grab links from it.detailUrl, never it.download) - so on a magnetCache
  // miss, resolveMagnet must know which download URL a given detailUrl had,
  // or it silently re-fetches the detail page instead of the row's own
  // download/thankyou link. Same bound/eviction policy as magnetCache.
  const downloadUrlCache = new Map<string, string>();
  function rememberDownloadUrl(detailUrl: string, downloadUrl: string): void {
    if (downloadUrlCache.size >= MAGNET_CACHE_MAX) {
      const oldest = downloadUrlCache.keys().next().value;
      if (oldest !== undefined) downloadUrlCache.delete(oldest);
    }
    downloadUrlCache.set(detailUrl, downloadUrl);
  }

  async function search(q: string, searchOpts: SearchOptions): Promise<SearchResult> {
    const searchBlock = asRecord(definition.search) as unknown as SearchBlockForPaths;
    const keywordsFilters = Array.isArray((definition.search as Record<string, unknown> | undefined)?.keywordsfilters)
      ? ((definition.search as Record<string, unknown>).keywordsfilters as FilterSpec[])
      : [];
    // Mirrors Cardigann's own Keywords assembly (Q + ... + Episode, joined
    // by spaces, skipping empties) - we only carry Q and Episode of the
    // real token set (see the file-level limitations comment).
    const episodeToken = episodeSearchString(searchOpts.season, searchOpts.ep);
    const rawKeywords = [q, episodeToken].filter(Boolean).join(' ');
    const keywords = applyFilters(keywordsFilters, rawKeywords);

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
        Type: searchOpts.type ?? 'search',
        Q: q,
        Keywords: rawKeywords,
        Season: searchOpts.season ?? '',
        Ep: searchOpts.ep ?? '',
        Episode: episodeToken,
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
      const body = await (await gatedFetch(req.url, { method: req.method, headers: req.headers, body: req.body })).text();
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
    // filter here instead.
    const filtered =
      searchOpts.categories && searchOpts.categories.length > 0
        ? allItems.filter((it) => searchOpts.categories?.includes(categoryIdByName(it.category)))
        : allItems;

    const page = filtered.slice(searchOpts.offset, searchOpts.offset + searchOpts.limit);

    const searchItems: SearchItem[] = page.map((it) => {
      const detailUrl = resolveUrl(it.detailUrl, baseUrl);
      const magnet = directMagnet(it);
      if (magnet) {
        rememberMagnet(detailUrl, magnet);
      } else if (it.download) {
        rememberDownloadUrl(detailUrl, resolveUrl(it.download, baseUrl));
      }

      return {
        title: it.title,
        detailUrl,
        size: it.size,
        seeds: it.seeds,
        leechers: it.leechers,
        category: categoryIdByName(it.category),
        pubDate: it.pubDate
      };
    });

    return { items: searchItems, total: filtered.length };
  }

  async function resolveMagnet({ url }: MagnetRef): Promise<ResolvedDownload> {
    if (!url) throw new Error(`${key}: resolveMagnet requires a url.`);

    const cached = magnetCache.get(url);
    if (cached) return { kind: 'magnet', magnet: cached };

    // Cache miss: the original item's title is gone by now (MagnetRef only
    // carries url) - fall back to re-deriving a magnet from whichever page
    // this detailUrl's row pointed at (its own download link if it had a
    // distinct one, else the detail page itself).
    const downloadUri = downloadUrlCache.get(url) ?? url;
    const resolved = await resolveCardigannDownload({
      definition,
      downloadUri,
      itemTitle: '',
      config,
      fetch: gatedFetch
    });
    // Only a magnet is worth remembering here - it's a cheap string that
    // never goes stale. A resolved .torrent file's bytes aren't cached: a
    // repeat grab re-fetching them fresh is an acceptable trade for not
    // growing this cache's type/memory footprint for what's normally a
    // one-shot download anyway.
    if (resolved.kind === 'magnet') rememberMagnet(url, resolved.magnet);
    return resolved;
  }

  return {
    id: key,
    name: String(definition.name ?? key),
    keepAlive: { url: baseUrl },
    categories: advertisedCategories,
    searchModes,
    searchParams,
    search,
    resolveMagnet
  };
}
