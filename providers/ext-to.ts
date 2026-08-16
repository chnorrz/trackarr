import crypto from 'crypto';
import * as cheerio from 'cheerio';
import { gotoCleared } from '../lib/browser.js';
import { CATEGORIES, matchCategory, type CategoryRule } from '../lib/categories.js';
import { parseSize } from '../lib/parse.js';
import type { MagnetRef, Provider, SearchItem } from '../lib/types.js';

const BASE = 'https://ext.to';
const MAGNET_ENDPOINT = `${BASE}/ajax/getSearchMagnet.php`;

function computeHMAC(torrentId: number, timestamp: number, token: string): string {
  return crypto.createHash('sha256').update(`${torrentId}|${timestamp}|${token}`).digest('hex');
}

// Matched against the breadcrumb text ("Movies", "Highres Movies", "TV").
// Order matters - first match wins.
const CATEGORY_RULES: CategoryRule[] = [
  [['tv', 'series'], CATEGORIES.TV],
  [['anime'], CATEGORIES.TV_ANIME],
  [['music', 'audio'], CATEGORIES.AUDIO],
  [['game', 'software', 'app'], CATEGORIES.PC],
  [['book', 'ebook'], CATEGORIES.BOOKS],
  [['xxx', 'adult'], CATEGORIES.XXX],
  [['movie'], CATEGORIES.MOVIES]
];

// Search results are scraped from /browse/?q=... . Magnet resolution reuses
// the search-listing page's own magnet flow (getSearchMagnet.php) - no
// torrent detail page visit needed, just a fresh /browse/ page load to get
// a valid page-nonce + csrf token, then the torrent id carried through from
// the search results.
async function search(q: string): Promise<SearchItem[]> {
  const searchUrl = `${BASE}/browse/?q=${encodeURIComponent(q)}`;
  const page = await gotoCleared(searchUrl);
  try {
    const html = await page.content();
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

    return items;
  } finally {
    await page.close();
  }
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
  testQuery: 'yify',
  search,
  resolveMagnet
} satisfies Provider;
