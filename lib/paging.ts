/** One site page's worth of results. */
export interface PageFetchResult<T> {
  items: T[];
  /** Exact total, if the site's own page told us (e.g. ext.to's "X - Y from
   * Z" text). Absent for sites with no such signal (e.g. 1337x). */
  totalHint?: number;
}

export interface PagedFetchOptions<T> {
  offset: number;
  limit: number;
  /** How many items the underlying site returns per page (fixed per site,
   * e.g. 1337x is always 20; ext.to is configurable but we always request
   * the same size so the math here stays simple). */
  sitePageSize: number;
  /** Hard ceiling on how deep we'll ever page into a site's real catalog for
   * one query, regardless of how large the real total is. Once exhausted,
   * we report a short/empty page so Prowlarr's own pagination stops instead
   * of paging up to its 30-page safety cap (see NOTES.md) - this is the
   * actual fix, <opensearch:totalResults> is not (Prowlarr ignores it). */
  depthCap: number;
  /** When set, only items passing this predicate count towards offset/limit
   * (used for the Torznab 'cat' param on real keyword searches - the site's
   * own search endpoint isn't category-filterable, so we filter afterwards
   * and keep paging deeper if a page comes back short after filtering). */
  filter?: (item: T) => boolean;
}

/**
 * Fetches however many 1-indexed site pages are needed to cover
 * [offset, offset+limit), stitches them together, and slices out exactly
 * the requested window - capped at depthCap regardless of what's requested
 * beyond it.
 *
 * With no filter, this jumps straight to the site pages that actually cover
 * the window (fast path). With a filter, the direct page-index math no
 * longer applies (a variable number of items per site page survive
 * filtering), so it scans sequentially from site page 1 instead, still
 * bounded by depthCap raw items scanned - same worst-case page-fetch count
 * as the unfiltered path, regardless of how selective the filter is.
 *
 * Either way, stops fetching early the moment a page comes back shorter
 * than sitePageSize (the real end of the site's results).
 */
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

  // No totalHint from the site itself, but a short page proves we've hit
  // the real end - use that as the exact total instead of the depth cap.
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

  // totalHint (when present) describes the unfiltered listing, so it isn't
  // a meaningful count here - only report an exact total once filtering has
  // actually run out of source items to look at.
  const total = ranOut ? matched.length : opts.depthCap;
  return { items: matched.slice(opts.offset, opts.offset + opts.limit), total };
}

export interface MergedBrowseOptions {
  offset: number;
  limit: number;
  sitePageSize: number;
  depthCap: number;
}

/**
 * Merges several independent "latest uploads" listings (one per requested
 * Torznab category, each already sorted newest-first) into a single
 * offset/limit window, ordered by pubDate descending. Used when a
 * blank-query browse needs to cover more than one category at once - each
 * tracker only exposes one category per listing URL, so there's no single
 * source to page through directly.
 *
 * Each source is fetched independently from its own item 0 up to
 * `min(offset+limit, depthCap)` (bounded the same way a single-source fetch
 * would be), then the pools are combined and sliced. `total` is the sum of
 * the per-source totals, capped at depthCap.
 */
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
