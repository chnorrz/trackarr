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

/** The contract every providers/*.ts module's default export must satisfy. */
export interface Provider {
  /** URL-path-safe id, e.g. "ext-to" - becomes /<id>/api and /<id>/download. */
  id: string;
  /** Display name, used in Torznab caps/RSS output. */
  name: string;
  /** Background warm-up target for server.ts's keep-alive scheduler. */
  keepAlive?: KeepAliveTarget;
  /** Substituted for Prowlarr's blank-query Test/Save requests - see
   * server.ts's search() for why every provider needs one that actually
   * returns results. */
  testQuery?: string;
  search(q: string): Promise<SearchItem[]>;
  resolveMagnet(ref: MagnetRef): Promise<string>;
}
