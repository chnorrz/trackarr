import crypto from 'crypto';
import * as cheerio from 'cheerio';
import { gotoCleared } from '../lib/browser.js';
import { CATEGORIES, matchCategory, type CategoryRule } from '../lib/categories.js';
import { fetchMergedBrowse, fetchPagedWindow } from '../lib/paging.js';
import { parseSize } from '../lib/parse.js';
import type { MagnetRef, Provider, SearchItem, SearchOptions, SearchResult } from '../lib/types.js';

const BASE = 'https://ext.to';
const MAGNET_ENDPOINT = `${BASE}/ajax/getSearchMagnet.php`;

// /browse/ page size - used for both keyword search and blank-query
// "latest" browsing, so fetchPagedWindow's paging math is consistent
// either way.
const SITE_PAGE_SIZE = 100;
// How deep into ext.to's own catalog trackarr will ever page for one query.
// This, not <opensearch:totalResults> (which Prowlarr never parses - see
// server.ts), is what actually stops Prowlarr's pagination: once offset
// reaches this cap search() returns a short/empty page.
const DEPTH_CAP = 200;

function computeHMAC(torrentId: number, timestamp: number, token: string): string {
  return crypto.createHash('sha256').update(`${torrentId}|${timestamp}|${token}`).digest('hex');
}

// Matched against the breadcrumb text ("Movies", "Highres Movies", "TV").
// Order matters - first match wins, and "audiobook" must stay above the
// generic "book"/"ebook" rule or every audiobook would be filed as a plain
// ebook.
const CATEGORY_RULES: CategoryRule[] = [
  [['tv', 'series'], CATEGORIES.TV],
  [['anime'], CATEGORIES.TV_ANIME],
  [['music', 'audio'], CATEGORIES.AUDIO],
  [['game', 'software', 'app'], CATEGORIES.PC],
  [['audiobook'], CATEGORIES.AUDIOBOOKS],
  [['book', 'ebook'], CATEGORIES.BOOKS],
  [['xxx', 'adult'], CATEGORIES.XXX],
  [['movie'], CATEGORIES.MOVIES]
];

interface BrowseTarget {
  cat: number;
  subCat?: number;
}

// Maps a Torznab category id to ext.to's own /browse/?cat=&sub_cat= params -
// used only for the blank-query "latest" path (a real keyword search isn't
// filtered server-side at all, see SearchOptions' doc comment). ext.to has
// no XXX category whatsoever, so CATEGORIES.XXX has no entry here - a
// blank query for it returns empty rather than being misrouted to Other.
const CATEGORY_BROWSE: Partial<Record<number, BrowseTarget>> = {
  [CATEGORIES.MOVIES]: { cat: 1 },
  [CATEGORIES.TV]: { cat: 2 },
  [CATEGORIES.AUDIO]: { cat: 3 },
  [CATEGORIES.PC_GAMES]: { cat: 4, subCat: 31 },
  // ext.to doesn't split console games by platform - anything that isn't a
  // PC game lands in its one "Other Games" bucket.
  [CATEGORIES.CONSOLE_OTHER]: { cat: 4, subCat: 32 },
  [CATEGORIES.PC]: { cat: 5 },
  [CATEGORIES.PC_MAC]: { cat: 5, subCat: 22 },
  [CATEGORIES.PC_MOBILE_ANDROID]: { cat: 5, subCat: 25 },
  [CATEGORIES.BOOKS]: { cat: 6 },
  [CATEGORIES.BOOKS_EBOOK]: { cat: 6, subCat: 6 },
  [CATEGORIES.AUDIOBOOKS]: { cat: 6, subCat: 20 },
  [CATEGORIES.TV_ANIME]: { cat: 7 },
  [CATEGORIES.OTHER]: { cat: 8 }
};

interface ListingPage {
  items: SearchItem[];
  totalHint?: number;
}

function parseListing(html: string): ListingPage {
  const $ = cheerio.load(html);
  const items: SearchItem[] = [];

  $('table.search-table tbody > tr').each((_, el) => {
    const $tr = $(el);
    const titleLink = $tr.find('a.torrent-title-link').first();
    const title = titleLink.text().trim();
    const href = titleLink.attr('href');
    if (!title || !href) return;
    const detailUrl = new URL(href, BASE).toString();

    const torrentId = parseInt($tr.find('a.search-magnet-btn[data-id]').first().attr('data-id') || '', 10);
    if (!torrentId) return;

    const tds = $tr.find('> td');
    const sizeText = $(tds[1]).find('span').last().text().trim();
    const ageSpan = $(tds[3]).find('span').last();
    const ageDate = ageSpan.attr('title');
    const seeds = parseInt($(tds[4]).text().replace(/\D/g, ''), 10) || 0;
    const leechers = parseInt($(tds[5]).text().replace(/\D/g, ''), 10) || 0;
    // .related-posted also contains an uploader link (href starts with
    // "?") before the category breadcrumb links (href starts with "/") -
    // filter it out or we'd pick up the uploader name instead.
    const categoryText = $tr.find('.related-posted a[href^="/"] strong').first().text().trim();

    const parsedDate = ageDate ? new Date(ageDate) : null;
    const pubDate = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : new Date();

    items.push({
      title,
      detailUrl,
      id: torrentId,
      size: parseSize(sizeText),
      seeds,
      leechers,
      category: matchCategory(categoryText, CATEGORY_RULES),
      pubDate
    });
  });

  // ext.to shows a "Showing X - Y from Z" results-count string on the page.
  // It isn't wrapped in a distinctive element, so match it generically
  // against the page's text rather than depending on a specific selector.
  const countMatch = $.root()
    .text()
    .match(/[\d,]+\s*-\s*[\d,]+\s*from\s*([\d,]+)/i);
  const totalHint = countMatch && countMatch[1] ? parseInt(countMatch[1].replace(/,/g, ''), 10) : undefined;

  return { items, totalHint };
}

async function fetchListingPage(url: string): Promise<ListingPage> {
  const page = await gotoCleared(url);
  try {
    return parseListing(await page.content());
  } finally {
    await page.close();
  }
}

function browsePage(target: BrowseTarget, sitePage: number): Promise<ListingPage> {
  const params = new URLSearchParams({
    sort: 'age',
    order: 'desc',
    cat: String(target.cat),
    page_size: String(SITE_PAGE_SIZE),
    page: String(sitePage)
  });
  if (target.subCat !== undefined) params.set('sub_cat', String(target.subCat));
  return fetchListingPage(`${BASE}/browse/?${params}`);
}

// Bare /browse/ with no cat/sub_cat param - ext.to's own "all categories,
// newest first" listing. Only used for a blank query with no cat requested
// at all (Torznab: absent cat -> return all categories); a specific cat (or
// several) routes through CATEGORY_BROWSE/fetchMergedBrowse instead.
function generalBrowsePage(sitePage: number): Promise<ListingPage> {
  const params = new URLSearchParams({ sort: 'age', order: 'desc', page_size: String(SITE_PAGE_SIZE), page: String(sitePage) });
  return fetchListingPage(`${BASE}/browse/?${params}`);
}

async function search(q: string, opts: SearchOptions): Promise<SearchResult> {
  const trimmed = q.trim();
  const paging = { offset: opts.offset, limit: opts.limit, sitePageSize: SITE_PAGE_SIZE, depthCap: DEPTH_CAP };

  if (!trimmed) {
    // Blank query ("Test" button, and every routine RSS/search sync - see
    // server.ts): browse the requested category/categories' latest uploads
    // instead of a keyword search.
    if (!opts.categories || opts.categories.length === 0) {
      return fetchPagedWindow(generalBrowsePage, paging);
    }

    const targets = opts.categories.map((id) => CATEGORY_BROWSE[id]).filter((t): t is BrowseTarget => t !== undefined);
    if (targets.length === 0) return { items: [], total: 0 }; // all requested cats unknown to ext.to (e.g. XXX)
    if (targets.length === 1) return fetchPagedWindow((sitePage) => browsePage(targets[0] as BrowseTarget, sitePage), paging);

    return fetchMergedBrowse(
      targets.map((target) => (sitePage: number) => browsePage(target, sitePage)),
      paging
    );
  }

  const filter = opts.categories?.length ? (item: SearchItem) => opts.categories?.includes(item.category) ?? true : undefined;
  return fetchPagedWindow(
    (sitePage) => {
      const params = new URLSearchParams({ q: trimmed, page_size: String(SITE_PAGE_SIZE), page: String(sitePage) });
      return fetchListingPage(`${BASE}/browse/?${params}`);
    },
    { ...paging, filter }
  );
}

interface MagnetPostResult {
  status: number;
  text: string;
}

// Resolves a magnet URI for a given torrent id using the search-listing
// page's magnet flow. `id` is the torrent id from search() - `url` is
// ignored, ext.to doesn't need the detail page at all.
async function resolveMagnet({ id }: MagnetRef): Promise<string> {
  if (!id) throw new Error('ext-to: resolveMagnet requires an id.');

  // Bare /browse/ (no query) doesn't render searchPageToken - needs an
  // actual results listing. A very short/single-char query seems to trip a
  // stricter WAF rule, so use a realistic-looking query string here.
  const page = await gotoCleared(`${BASE}/browse/?q=yify`);
  try {
    const html = await page.content();

    const pageTokenMatch = html.match(/searchPageToken\s*=\s*['"]([^'"]+)['"]/);
    if (!pageTokenMatch || !pageTokenMatch[1]) throw new Error('Could not find window.searchPageToken on page.');
    const pageToken = pageTokenMatch[1];

    const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (!csrfMatch || !csrfMatch[1]) throw new Error('Could not find csrf-token meta tag on page.');
    const sessid = csrfMatch[1];

    const timestamp = Math.floor(Date.now() / 1000);
    const hmac = computeHMAC(id, timestamp, pageToken);

    const result = await page.evaluate<MagnetPostResult, { endpoint: string; torrentId: number; timestamp: number; hmac: string; sessid: string }>(
      async ({ endpoint, torrentId, timestamp, hmac, sessid }) => {
        const body = new URLSearchParams({
          torrent_id: String(torrentId),
          hash: '',
          name: '',
          timestamp: String(timestamp),
          hmac,
          sessid
        });
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          body
        });
        const text = await res.text();
        return { status: res.status, text };
      },
      { endpoint: MAGNET_ENDPOINT, torrentId: id, timestamp, hmac, sessid }
    );

    let json: { success?: boolean; url?: string };
    try {
      json = JSON.parse(result.text);
    } catch {
      throw new Error(`Non-JSON response (status ${result.status}): ${result.text.slice(0, 300)}`);
    }

    if (!json.success || !json.url || typeof json.url !== 'string' || !json.url.startsWith('magnet:')) {
      throw new Error(`No magnet in response: ${JSON.stringify(json)}`);
    }

    return json.url;
  } finally {
    await page.close();
  }
}

export default {
  id: 'ext-to',
  name: 'ext.to',
  // Background warm-up target. Must be a real listing page: bare /browse/
  // doesn't render searchPageToken, and the challenge lives on the listing
  // path rather than the homepage.
  keepAlive: { url: `${BASE}/browse/?q=yify` },
  // No XXX or Mobile-iOS here - ext.to doesn't offer either.
  categories: [
    CATEGORIES.MOVIES,
    CATEGORIES.TV,
    CATEGORIES.TV_ANIME,
    CATEGORIES.AUDIO,
    CATEGORIES.AUDIOBOOKS,
    CATEGORIES.PC,
    CATEGORIES.PC_MAC,
    CATEGORIES.PC_MOBILE_ANDROID,
    CATEGORIES.PC_GAMES,
    CATEGORIES.CONSOLE_OTHER,
    CATEGORIES.BOOKS,
    CATEGORIES.BOOKS_EBOOK,
    CATEGORIES.OTHER
  ],
  search,
  resolveMagnet
} satisfies Provider;
