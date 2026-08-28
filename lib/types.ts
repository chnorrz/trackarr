export interface SearchItem {
  title: string;
  detailUrl: string;
  size: number;
  seeds: number;
  leechers: number;
  category: number;
  pubDate: Date;
}

export interface MagnetRef {
  url: string;
}

// What a grab resolves to: either a magnet: URI (server.ts redirects the
// client to it directly), or a real .torrent file's raw bytes (server.ts
// fetched it itself - through the same Cloudflare-bypassed session a
// downstream client couldn't manage on its own - and streams them back).
export type ResolvedDownload = { kind: 'magnet'; magnet: string } | { kind: 'torrent'; data: Buffer; filename: string };

export interface KeepAliveTarget {
  url: string;
}

export interface ProviderCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
}

export interface SearchOptions {
  /** Raw Torznab t= value (search/tvsearch/movie/music/book) - a definition
   * can branch on it via .Query.Type (real Prowlarr: SearchType is the
   * literal t= value, not the caps.modes name - confirmed against
   * ReleaseSearchService.cs). Defaults to 'search' for callers that don't
   * pass one (every test, and any future caller with nothing more specific). */
  type?: string;
  /** Raw season/ep Torznab params (tvsearch only). Passed through as-is;
   * the Cardigann adapter turns them into an "S01E02"-style token appended
   * to Keywords, mirroring Prowlarr's own TvSearchCriteria.EpisodeSearchString. */
  season?: string;
  ep?: string;
  categories?: number[];
  offset: number;
  limit: number;
}

export interface SearchResult {
  items: SearchItem[];
  total: number;
}

// Torznab t= values, not caps.modes' own names - server.ts dispatches on
// these directly, and they double as the raw .Query.Type a definition sees
// (see SearchOptions.type). 'music'/'book' render as caps' <audio-search>/
// <book-search> respectively - Newznab's own naming mismatch, confirmed
// against Prowlarr's IndexerCapabilities.cs, not something we invented.
export type SearchMode = 'search' | 'tvsearch' | 'movie' | 'music' | 'book';

export interface Provider {
  id: string;
  name: string;
  keepAlive?: KeepAliveTarget;
  cookies?: ProviderCookie[];
  categories: number[];
  /** Always includes 'search' (caps.modes.search is schema-required). */
  searchModes: SearchMode[];
  /** Per-mode supported Torznab param names, exactly as declared in the
   * definition's caps.modes (e.g. tvsearch -> ['q','season','ep']). Only
   * has an entry for modes present in searchModes; a caller should fall
   * back to ['q'] for any mode without one (matches Prowlarr's own
   * IndexerCapabilities default). */
  searchParams: Partial<Record<SearchMode, string[]>>;
  search(q: string, opts: SearchOptions): Promise<SearchResult>;
  resolveMagnet(ref: MagnetRef): Promise<ResolvedDownload>;
}
