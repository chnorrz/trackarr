import * as cheerio from 'cheerio';
import { fetchCfProtectedPage } from '../lib/browser.js';
import { CATEGORIES } from '../lib/categories.js';
import { TTLCache } from '../lib/cache.js';
import { parseSize } from '../lib/parse.js';
import type { MagnetRef, Provider, SearchItem, SearchOptions, SearchResult } from '../lib/types.js';

const BASE = 'https://eztvx.to';
// How deep into EZTV's own catalog trackarr will ever page for one blank
// query. This, not <opensearch:totalResults>, is what actually stops
// Prowlarr's pagination - see server.ts.
const DEPTH_CAP = 200;

// browseLatest() below still doesn't go through fetchCfProtectedPage() -
// EZTV's JSON API isn't Cloudflare-protected to begin with (a plain
// server-side fetch() is fine and cheaper than a browser page), so it gets
// its own small cache instead, same TTL/env var as fetchCfProtectedPage's
// for consistency.
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000;

// EZTV also has an official, unauthenticated JSON API
// (https://eztvx.to/api/get-torrents) - but it only supports pagination and
// exact IMDB-id lookup, no free-text search, so it can't serve search(q) on
// its own. /search/ needs the same Cloudflare clearing as the rest of the
// site (the homepage and the API don't - only the search path is
// protected, same pattern as ext.to).
//
// The search page's results table normally shows a "Show links" button per
// row instead of a magnet link. That button POSTs layout=def_wlinks back to
// the same search URL (a page-wide layout switch, not a per-row action) -
// the server responds with the SAME results re-rendered with a magnet link
// embedded directly in each row. Reproducing that POST directly (same
// pattern as ext.to's magnet API - see providers/ext-to.ts) means search()
// can capture every result's magnet in the same request that finds it,
// instead of needing a separate detail-page visit per grab like 1337x.
//
// resolveMagnet() still exists and still works standalone (a fresh detail-
// page visit, same shape as 1337x) - it's the fallback for when a result's
// magnet has aged out of magnetCache below (e.g. the process restarted
// between search and grab).
const magnetCache = new Map<string, string>();
const MAGNET_CACHE_MAX = 500;

function rememberMagnet(detailUrl: string, magnet: string): void {
  if (magnetCache.size >= MAGNET_CACHE_MAX) {
    const oldest = magnetCache.keys().next().value;
    if (oldest !== undefined) magnetCache.delete(oldest);
  }
  magnetCache.set(detailUrl, magnet);
}

// Caches the whole parsed result list per keyword - searchByKeyword()
// always fetches the entire matching set in one page (no pagination of its
// own), so this is what actually fixes the previously-noted inefficiency
// of every distinct offset re-scraping the whole site from scratch: real
// pagination just slices this cached list.
const keywordSearchCache = new TTLCache<SearchItem[]>(CACHE_TTL_MS);

function parseSearchRows(html: string): SearchItem[] {
  const $ = cheerio.load(html);
  const items: SearchItem[] = [];

  $('tr[name="hover"].forum_header_border').each((_, el) => {
    const $tr = $(el);
    const titleLink = $tr.find('a.epinfo').first();
    const href = titleLink.attr('href');
    if (!href) return;
    const detailUrl = new URL(href, BASE).toString();

    // The visible anchor text is truncated with "..."; the title attr has
    // the full release name plus a " (176 MB)" size suffix appended -
    // strip that off rather than depend on a size <td>'s fixed column
    // position, which shifts on rows that render an extra "Show links"
    // button cell (before the reveal POST below).
    const titleAttr = titleLink.attr('title') || titleLink.text();
    const sizeMatch = titleAttr.match(/\(([\d.,]+\s*(?:B|KB|MB|GB|TB))\)\s*$/i);
    const title = (sizeMatch && sizeMatch.index !== undefined ? titleAttr.slice(0, sizeMatch.index) : titleAttr).trim();
    const size = sizeMatch && sizeMatch[1] ? parseSize(sizeMatch[1]) : 0;

    const magnet = $tr.find('a.magnet[href^="magnet:"]').first().attr('href');
    if (magnet) rememberMagnet(detailUrl, magnet);

    items.push({
      title,
      detailUrl,
      id: null,
      size,
      // Search rows don't show seed/leech counts (just "-"); the detail
      // page's numbers are chart-widget-driven, not plain HTML, so not
      // reliably scrapable either. Default to 0 rather than guess.
      seeds: 0,
      leechers: 0,
      // The whole site is TV-only, no per-row genre/category signal in
      // the search results markup.
      category: CATEGORIES.TV,
      // No exact-date attribute on the search page (just relative text
      // like "1 mo"), so same best-effort fallback as 1337x.
      pubDate: new Date()
    });
  });

  return items;
}

async function searchByKeyword(q: string): Promise<SearchItem[]> {
  const cached = keywordSearchCache.get(q);
  if (cached) return cached;

  const searchUrl = `${BASE}/search/?q1=${encodeURIComponent(q)}`;

  // GET first - confirmed live this is required, not just a nice-to-have.
  // The reveal POST (see comment above search()) does return the FULL
  // page with magnet links unlocked, not just a fragment, when the page's
  // session already has real prior context from visiting /search/ itself.
  // But fetchCfProtectedPage()'s generic recovery path (used whenever the
  // fast path fails) reloads wherever the page is CURRENTLY sitting, which
  // - without this GET - can be some unrelated page (e.g. keepAlive's
  // homepage visit), and the reveal POST then fails outright even after
  // that reload. A GET to searchUrl itself guarantees the page has real
  // /search/ context before the POST ever runs, whether via this call's
  // own fast path or its own recovery. Result discarded on purpose - only
  // its side effect (a correctly-primed page) matters here.
  await fetchCfProtectedPage(searchUrl);

  const html = await fetchCfProtectedPage(searchUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ layout: 'def_wlinks' }).toString()
  });

  const items = parseSearchRows(html);

  // Never cache an empty result - could be a transient scrape failure
  // rather than a genuinely zero-result search, and freezing that in for
  // the full TTL would keep serving it after the underlying problem's
  // fixed (same reasoning the old top-level search cache used to apply).
  if (items.length) keywordSearchCache.set(q, items);
  return items;
}

interface EztvApiTorrent {
  id: number;
  title?: string;
  filename: string;
  magnet_url: string;
  seeds: number;
  peers: number;
  date_released_unix: number;
  // Comes back as a string in the JSON, not a number - confirmed live.
  size_bytes: string;
}

interface EztvApiResponse {
  torrents_count: number;
  torrents: EztvApiTorrent[];
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// EZTV's JSON API (https://eztvx.to/api/get-torrents) supports pagination
// but no free-text search, so it's only usable for the blank-query "latest"
// path (see searchByKeyword() above for real queries). Fetched with a plain
// server-side fetch rather than fetchCfProtectedPage()/the browser - this endpoint
// isn't behind the site's Cloudflare challenge (same as the homepage - only
// /search/ is protected), and a plain fetch is much cheaper than spinning
// up a browser page for it. If that ever changes and this endpoint gets
// protected too, this will start failing outright rather than degrading -
// accepted risk (see NOTES.md).
//
// Cached by the exact API URL (which already encodes limit+page) - its own
// apiPage math already avoids overlapping fetches across an offset walk
// (see the comment below), so this isn't fixing a redundant-fetch problem
// the way the other two caches in this file are. It's here so an identical
// repeated request (e.g. Prowlarr's periodic RSS poll hitting the same
// offset/limit) is still a no-op, now that server.ts no longer has a
// top-level cache doing that job.
const apiCache = new TTLCache<EztvApiResponse>(CACHE_TTL_MS);

async function browseLatest(opts: SearchOptions): Promise<SearchResult> {
  const limit = opts.limit;
  const cappedEnd = Math.min(opts.offset + limit, DEPTH_CAP);
  if (opts.offset >= cappedEnd) return { items: [], total: DEPTH_CAP };

  // The API's own page size is whatever `limit` we ask for, so a single
  // API page lines up exactly with our requested window as long as offset
  // stays a multiple of limit across one pagination sequence - true for
  // both Prowlarr's paginated search and its RSS sync (see NOTES.md).
  const apiPage = Math.floor(opts.offset / limit) + 1;
  const apiUrl = `${BASE}/api/get-torrents?limit=${limit}&page=${apiPage}`;

  let data = apiCache.get(apiUrl);
  if (!data) {
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`eztv API request failed: ${res.status}`);
    data = (await res.json()) as EztvApiResponse;
    apiCache.set(apiUrl, data);
  }

  // Runs on every call, cache hit or not - rememberMagnet() must repopulate
  // magnetCache regardless, since that's a separate (non-TTL, LRU-ish)
  // cache that download requests depend on.
  const items: SearchItem[] = (data.torrents || []).map((t) => {
    const title = t.title || t.filename;
    // Not necessarily the site's real canonical URL for this episode (that
    // requires a live page visit to confirm, and the detail page 403s for
    // plain requests anyway) - only needs to be internally consistent,
    // since it's used purely as an RSS guid and a magnetCache key, and the
    // magnet itself comes inline from the API below.
    const detailUrl = `${BASE}/ep/${t.id}/${slugify(title)}/`;
    rememberMagnet(detailUrl, t.magnet_url);

    return {
      title,
      detailUrl,
      id: t.id,
      size: Number(t.size_bytes) || 0,
      seeds: t.seeds || 0,
      leechers: t.peers || 0,
      category: CATEGORIES.TV,
      pubDate: new Date(t.date_released_unix * 1000)
    };
  });

  return { items, total: Math.min(data.torrents_count || 0, DEPTH_CAP) };
}

async function search(q: string, opts: SearchOptions): Promise<SearchResult> {
  // EZTV is TV-only - if the caller explicitly asked for categories that
  // don't include TV, nothing on this tracker can ever match (same outcome
  // as filtering item-by-item, just without needing a filter mechanism
  // since every item here is always CATEGORIES.TV).
  if (opts.categories && opts.categories.length > 0 && !opts.categories.includes(CATEGORIES.TV)) {
    return { items: [], total: 0 };
  }

  const trimmed = q.trim();
  if (!trimmed) return browseLatest(opts);

  // The Cloudflare-scrape search path returns one full results page with
  // no pagination support of its own - slice locally so offset/limit are
  // still honoured consistently with the blank-query path.
  const items = await searchByKeyword(trimmed);
  return { items: items.slice(opts.offset, opts.offset + opts.limit), total: items.length };
}

async function resolveMagnet({ url }: MagnetRef): Promise<string> {
  if (!url) throw new Error('eztv: resolveMagnet requires a url.');

  const cached = magnetCache.get(url);
  if (cached) return cached;

  // Fallback: magnet is also embedded directly on the episode detail page -
  // no AJAX/HMAC dance, same as 1337x. Pure read, no live page needed.
  const html = await fetchCfProtectedPage(url);
  const $ = cheerio.load(html);
  const magnet = $('a[href^="magnet:"]').first().attr('href');
  if (!magnet) throw new Error('Could not find a magnet link on the episode page.');
  return magnet;
}

export default {
  id: 'eztv',
  name: 'EZTV',
  // Must be the search path, not the bare homepage - the challenge lives
  // there, not on / (confirmed live: curl to / clears with no challenge at
  // all, curl to /search/ gets a real Turnstile "Just a moment..." page).
  // Same shape as ext-to.ts's own keepAlive, for the identical reason.
  keepAlive: { url: `${BASE}/search/?q1=the` },
  // TV-only site, no other content exists to advertise.
  categories: [CATEGORIES.TV],
  search,
  resolveMagnet
} satisfies Provider;
