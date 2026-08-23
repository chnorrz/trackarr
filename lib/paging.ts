export interface PageFetchResult<T> {
  items: T[];
  totalHint?: number;
}

export interface PagedFetchOptions<T> {
  offset: number;
  limit: number;
  sitePageSize: number;
  /** Once exhausted we return a short page, which is what makes Prowlarr's own
   * pagination stop instead of running to its 30-page safety cap. */
  depthCap: number;
  filter?: (item: T) => boolean;
}

export async function fetchPagedWindow<T>(
  fetchPage: (sitePage: number) => Promise<PageFetchResult<T>>,
  opts: PagedFetchOptions<T>
): Promise<{ items: T[]; total: number }> {
  const cappedEnd = Math.min(opts.offset + opts.limit, opts.depthCap);
  if (opts.offset >= cappedEnd) return { items: [], total: opts.depthCap };

  if (opts.filter) return fetchFilteredWindow(fetchPage, opts, cappedEnd);

  const firstSitePage = Math.floor(opts.offset / opts.sitePageSize) + 1;
  const lastSitePage = Math.floor((cappedEnd - 1) / opts.sitePageSize) + 1;
  const poolBaseOffset = (firstSitePage - 1) * opts.sitePageSize;

  const pool: T[] = [];
  let total = opts.depthCap;
  let ranOut = false;

  for (let sitePage = firstSitePage; sitePage <= lastSitePage; sitePage++) {
    const { items, totalHint } = await fetchPage(sitePage);
    if (totalHint !== undefined) total = Math.min(totalHint, opts.depthCap);
    pool.push(...items);
    if (items.length < opts.sitePageSize) {
      ranOut = true;
      break;
    }
  }

  if (ranOut && total === opts.depthCap) {
    total = poolBaseOffset + pool.length;
  }

  const startInPool = opts.offset - poolBaseOffset;
  const items = pool.slice(startInPool, startInPool + opts.limit);
  return { items, total };
}

async function fetchFilteredWindow<T>(
  fetchPage: (sitePage: number) => Promise<PageFetchResult<T>>,
  opts: PagedFetchOptions<T>,
  cappedEnd: number
): Promise<{ items: T[]; total: number }> {
  const filter = opts.filter as (item: T) => boolean;
  const matched: T[] = [];
  let rawSeen = 0;
  let ranOut = false;

  for (let sitePage = 1; rawSeen < opts.depthCap && matched.length < cappedEnd; sitePage++) {
    const { items } = await fetchPage(sitePage);
    rawSeen += items.length;
    matched.push(...items.filter(filter));
    if (items.length < opts.sitePageSize) {
      ranOut = true;
      break;
    }
  }

  const total = ranOut ? matched.length : opts.depthCap;
  return { items: matched.slice(opts.offset, opts.offset + opts.limit), total };
}

export interface MergedBrowseOptions {
  offset: number;
  limit: number;
  sitePageSize: number;
  depthCap: number;
}

export async function fetchMergedBrowse<T extends { pubDate: Date }>(
  sources: Array<(sitePage: number) => Promise<PageFetchResult<T>>>,
  opts: MergedBrowseOptions
): Promise<{ items: T[]; total: number }> {
  const cappedEnd = Math.min(opts.offset + opts.limit, opts.depthCap);
  if (sources.length === 0 || opts.offset >= cappedEnd) return { items: [], total: 0 };

  const perSource = await Promise.all(
    sources.map((fetchPage) =>
      fetchPagedWindow(fetchPage, { offset: 0, limit: cappedEnd, sitePageSize: opts.sitePageSize, depthCap: opts.depthCap })
    )
  );

  const pool = perSource.flatMap((r) => r.items);
  pool.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  const total = Math.min(perSource.reduce((sum, r) => sum + r.total, 0), opts.depthCap);
  return { items: pool.slice(opts.offset, opts.offset + opts.limit), total };
}
