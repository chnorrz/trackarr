export interface SearchItem {
  title: string;
  detailUrl: string;
  id: number | null;
  size: number;
  seeds: number;
  leechers: number;
  category: number;
  pubDate: Date;
}

export interface MagnetRef {
  id: number | null;
  url: string | null;
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
  categories?: number[];
  offset: number;
  limit: number;
}

export interface SearchResult {
  items: SearchItem[];
  total: number;
}

export interface Provider {
  id: string;
  name: string;
  keepAlive?: KeepAliveTarget;
  cookies?: ProviderCookie[];
  categories: number[];
  search(q: string, opts: SearchOptions): Promise<SearchResult>;
  resolveMagnet(ref: MagnetRef): Promise<ResolvedDownload>;
}
