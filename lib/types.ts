/** A single search result row, in the shape server.js turns into Torznab RSS. */
export interface SearchItem {
  title: string;
  detailUrl: string;
  /** Provider-internal id (e.g. a torrent id), when the provider has one. */
  id: number | null;
  /** Bytes, or 0 if unknown/unparseable. */
  size: number;
  seeds: number;
  leechers: number;
  /** Torznab category id, see lib/categories.ts. */
  category: number;
  pubDate: Date;
}

/** What a provider's resolveMagnet() is given - whatever search() put in the
 * item's `id`/`detailUrl`, passed back through the /download route. */
export interface MagnetRef {
  id: number | null;
  url: string | null;
}

export interface KeepAliveTarget {
  url: string;
  /** Provider id to route through PROXY_URL, matching gotoCleared's opts.proxy. */
  proxy?: string;
}

export interface SearchOptions {
  /** Torznab 'cat' param - already split into individual ids. Undefined or
   * empty means no restriction (spec: absent cat -> return all categories).
   * Applied two ways: for a blank q, picks which category/categories to
   * browse ("latest uploads"); for a real keyword search, filters the
   * results down to items whose classified category is in this list. */
  categories?: number[];
  /** Torznab paging - 0-based item offset and page size. Every provider is
   * expected to honour these (not just for blank-query browsing): once a
   * provider's real results run out, it must return a short/empty page
   * rather than always returning the same full set regardless of offset -
   * that's what lets Prowlarr's own pagination stop correctly instead of
   * paging up to its hardcoded 30-page safety cap (see NOTES.md). */
  offset: number;
  limit: number;
}

export interface SearchResult {
  items: SearchItem[];
  /** Total matching items, for Torznab's <opensearch:totalResults> - not
   * relied upon by Prowlarr itself (confirmed it never parses this), kept
   * for spec-compliance with other Torznab clients. Can be an estimate
   * when the provider has no exact count (see providers/1337x.ts). */
  total: number;
}

/** The contract every providers/*.ts module's default export must satisfy. */
export interface Provider {
  /** URL-path-safe id, e.g. "ext-to" - becomes /<id>/api and /<id>/download. */
  id: string;
  /** Display name, used in Torznab caps/RSS output. */
  name: string;
  /** Background warm-up target for server.ts's keep-alive scheduler. */
  keepAlive?: KeepAliveTarget;
  /** Exact set of Torznab category ids this provider's content can be
   * classified into (see lib/categories.ts's CATEGORIES) - drives the
   * <categories> block in caps output, so e.g. EZTV (TV-only) doesn't
   * advertise Movies/Books/XXX/etc just because other providers have them. */
  categories: number[];
  search(q: string, opts: SearchOptions): Promise<SearchResult>;
  resolveMagnet(ref: MagnetRef): Promise<string>;
}
