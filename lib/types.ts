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
  resolveMagnet(ref: MagnetRef): Promise<string>;
}
