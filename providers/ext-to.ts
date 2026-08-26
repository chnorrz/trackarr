import crypto from 'crypto';
import * as cheerio from 'cheerio';
import { cfFetch } from '../lib/browser.js';
import { CATEGORIES, matchCategory, type CategoryRule } from '../lib/categories.js';
import { fetchMergedBrowse, fetchPagedWindow } from '../lib/paging.js';
import { parseSize } from '../lib/parse.js';
import type { MagnetRef, Provider, ResolvedDownload, SearchItem, SearchOptions, SearchResult } from '../lib/types.js';

const BASE = 'https://ext.to';
const MAGNET_ENDPOINT = `${BASE}/ajax/getSearchMagnet.php`;

const SITE_PAGE_SIZE = 100;
const DEPTH_CAP = 200;

function computeHMAC(torrentId: number, timestamp: number, token: string): string {
  return crypto.createHash('sha256').update(`${torrentId}|${timestamp}|${token}`).digest('hex');
}

// Order matters - first match wins, so every subcategory slug must stay
// above its generic parent (audio-books/ebooks above /books/, etc).
const CATEGORY_RULES: CategoryRule[] = [
  [['/tv/'], CATEGORIES.TV],
  [['/anime/'], CATEGORIES.TV_ANIME],
  [['/books/audio-books/'], CATEGORIES.AUDIOBOOKS],
  [['/music/'], CATEGORIES.AUDIO],
  [['/games/pc-games/'], CATEGORIES.PC_GAMES],
  [['/games/other-games/'], CATEGORIES.CONSOLE_OTHER],
  [['/games/'], CATEGORIES.PC_GAMES],
  [['/applications/mac/'], CATEGORIES.PC_MAC],
  [['/applications/android/'], CATEGORIES.PC_MOBILE_ANDROID],
  [['/applications/'], CATEGORIES.PC],
  [['/books/ebooks/'], CATEGORIES.BOOKS_EBOOK],
  [['/books/'], CATEGORIES.BOOKS],
  [['/movies/'], CATEGORIES.MOVIES]
];

interface BrowseTarget {
  cat: number;
  subCat?: number;
}

const CATEGORY_BROWSE: Partial<Record<number, BrowseTarget>> = {
  [CATEGORIES.MOVIES]: { cat: 1 },
  [CATEGORIES.TV]: { cat: 2 },
  [CATEGORIES.AUDIO]: { cat: 3 },
  [CATEGORIES.PC_GAMES]: { cat: 4, subCat: 31 },
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

function parseListing(html: string, knownCategory?: number): ListingPage {
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

    const parsedDate = ageDate ? new Date(ageDate) : null;
    const pubDate = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate : new Date();

    // .related-posted also holds an uploader link, hence the /user/ exclusion.
    // Match hrefs, not link text - the display text drifts ("Audio books").
    const categoryHrefs = $tr
      .find('.related-posted a[href^="/"]:not([href^="/user/"])')
      .map((_, a) => $(a).attr('href') || '')
      .get()
      .join(' ');
    const category = knownCategory ?? matchCategory(categoryHrefs, CATEGORY_RULES);

    items.push({
      title,
      detailUrl,
      id: torrentId,
      size: parseSize(sizeText),
      seeds,
      leechers,
      category,
      pubDate
    });
  });

  const countMatch = $.root()
    .text()
    .match(/[\d,]+\s*-\s*[\d,]+\s*from\s*([\d,]+)/i);
  const totalHint = countMatch && countMatch[1] ? parseInt(countMatch[1].replace(/,/g, ''), 10) : undefined;

  return { items, totalHint };
}

async function fetchListingPage(url: string, knownCategory?: number): Promise<ListingPage> {
  const html = await (await cfFetch(url)).text();
  return parseListing(html, knownCategory);
}

function browsePage(target: BrowseTarget, categoryId: number, sitePage: number): Promise<ListingPage> {
  const params = new URLSearchParams({
    sort: 'age',
    order: 'desc',
    cat: String(target.cat),
    page_size: String(SITE_PAGE_SIZE),
    page: String(sitePage)
  });
  if (target.subCat !== undefined) params.set('sub_cat', String(target.subCat));
  return fetchListingPage(`${BASE}/browse/?${params}`, categoryId);
}

function generalBrowsePage(sitePage: number): Promise<ListingPage> {
  // Without `age`, bare /browse/ renders a category-picker landing page
  // instead of a results table. `age=4` is what the site's own link uses.
  const params = new URLSearchParams({ sort: 'age', order: 'desc', age: '4', page_size: String(SITE_PAGE_SIZE), page: String(sitePage) });
  return fetchListingPage(`${BASE}/browse/?${params}`);
}

async function search(q: string, opts: SearchOptions): Promise<SearchResult> {
  const trimmed = q.trim();
  const paging = { offset: opts.offset, limit: opts.limit, sitePageSize: SITE_PAGE_SIZE, depthCap: DEPTH_CAP };

  if (!trimmed) {
    if (!opts.categories || opts.categories.length === 0) {
      return fetchPagedWindow(generalBrowsePage, paging);
    }

    const targets = opts.categories
      .map((id) => (CATEGORY_BROWSE[id] ? { id, target: CATEGORY_BROWSE[id] as BrowseTarget } : undefined))
      .filter((t): t is { id: number; target: BrowseTarget } => t !== undefined);
    if (targets.length === 0) return { items: [], total: 0 };
    if (targets.length === 1) {
      const only = targets[0] as { id: number; target: BrowseTarget };
      return fetchPagedWindow((sitePage) => browsePage(only.target, only.id, sitePage), paging);
    }

    return fetchMergedBrowse(
      targets.map(({ id, target }) => (sitePage: number) => browsePage(target, id, sitePage)),
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

async function resolveMagnet({ id }: MagnetRef): Promise<ResolvedDownload> {
  if (!id) throw new Error('ext-to: resolveMagnet requires an id.');

  // Needs a real results listing - bare /browse/ renders no searchPageToken,
  // and a very short query trips a stricter WAF rule.
  const html = await (await cfFetch(`${BASE}/browse/?q=yify`)).text();

  const pageTokenMatch = html.match(/searchPageToken\s*=\s*['"]([^'"]+)['"]/);
  if (!pageTokenMatch || !pageTokenMatch[1]) throw new Error('Could not find window.searchPageToken on page.');
  const pageToken = pageTokenMatch[1];

  const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  if (!csrfMatch || !csrfMatch[1]) throw new Error('Could not find csrf-token meta tag on page.');
  const sessid = csrfMatch[1];

  const timestamp = Math.floor(Date.now() / 1000);
  const hmac = computeHMAC(id, timestamp, pageToken);

  const responseText = await (
    await cfFetch(MAGNET_ENDPOINT, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        torrent_id: String(id),
        hash: '',
        name: '',
        timestamp: String(timestamp),
        hmac,
        sessid
      }).toString()
    })
  ).text();

  let json: { success?: boolean; url?: string };
  try {
    json = JSON.parse(responseText);
  } catch {
    throw new Error(`Non-JSON response: ${responseText.slice(0, 300)}`);
  }

  if (!json.success || !json.url || typeof json.url !== 'string' || !json.url.startsWith('magnet:')) {
    throw new Error(`No magnet in response: ${JSON.stringify(json)}`);
  }

  return { kind: 'magnet', magnet: json.url };
}

export default {
  id: 'ext-to',
  name: 'ext.to',
  keepAlive: { url: `${BASE}/browse/?q=yify` },
  categories: Object.keys(CATEGORY_BROWSE).map(Number),
  search,
  resolveMagnet
} satisfies Provider;
