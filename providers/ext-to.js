import crypto from 'crypto';
import * as cheerio from 'cheerio';
import { gotoCleared } from '../lib/browser.js';
import { CATEGORIES } from '../lib/categories.js';

const BASE = 'https://ext.to';
const MAGNET_ENDPOINT = `${BASE}/ajax/getSearchMagnet.php`;

function computeHMAC(torrentId, timestamp, token) {
  return crypto.createHash('sha256').update(`${torrentId}|${timestamp}|${token}`).digest('hex');
}

function parseSize(str) {
  const m = /^([\d.,]+)\s*(B|KB|MB|GB|TB)$/i.exec((str || '').trim());
  if (!m) return 0;
  const num = parseFloat(m[1].replace(',', ''));
  const unit = m[2].toUpperCase();
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit];
  return Math.round(num * mult);
}

function mapCategory(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('tv') || n.includes('series')) return CATEGORIES.TV;
  if (n.includes('anime')) return CATEGORIES.TV_ANIME;
  if (n.includes('music') || n.includes('audio')) return CATEGORIES.AUDIO;
  if (n.includes('game')) return CATEGORIES.PC;
  if (n.includes('software') || n.includes('app')) return CATEGORIES.PC;
  if (n.includes('book') || n.includes('ebook')) return CATEGORIES.BOOKS;
  if (n.includes('xxx') || n.includes('adult')) return CATEGORIES.XXX;
  if (n.includes('movie')) return CATEGORIES.MOVIES;
  return CATEGORIES.OTHER;
}

// Search results are scraped from /browse/?q=... . Magnet resolution reuses
// the search-listing page's own magnet flow (getSearchMagnet.php) - no
// torrent detail page visit needed, just a fresh /browse/ page load to get
// a valid page-nonce + csrf token, then the torrent id carried through from
// the search results.
async function search(q) {
  const searchUrl = `${BASE}/browse/?q=${encodeURIComponent(q)}`;
  const page = await gotoCleared(searchUrl);
  try {
    const html = await page.content();
    const $ = cheerio.load(html);
    const items = [];

    $('table.search-table tbody > tr').each((_, el) => {
      const $tr = $(el);
      const titleLink = $tr.find('a.torrent-title-link').first();
      const title = titleLink.text().trim();
      const href = titleLink.attr('href');
      if (!title || !href) return;
      const detailUrl = new URL(href, BASE).toString();

      const torrentId = parseInt($tr.find('a.search-magnet-btn[data-id]').first().attr('data-id'), 10);
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
      const pubDate = parsedDate && !isNaN(parsedDate) ? parsedDate : new Date();

      items.push({
        title,
        detailUrl,
        id: torrentId,
        size: parseSize(sizeText),
        seeds,
        leechers,
        category: mapCategory(categoryText),
        pubDate
      });
    });

    return items;
  } finally {
    await page.close();
  }
}

// Resolves a magnet URI for a given torrent id using the search-listing
// page's magnet flow. `id` is the torrent id from search() - `url` is
// ignored, ext.to doesn't need the detail page at all.
async function resolveMagnet({ id }) {
  if (!id) throw new Error('ext-to: resolveMagnet requires an id.');

  // Bare /browse/ (no query) doesn't render searchPageToken - needs an
  // actual results listing. A very short/single-char query seems to trip a
  // stricter WAF rule, so use a realistic-looking query string here.
  const page = await gotoCleared(`${BASE}/browse/?q=yify`);
  try {
    const html = await page.content();

    const pageTokenMatch = html.match(/searchPageToken\s*=\s*['"]([^'"]+)['"]/);
    if (!pageTokenMatch) throw new Error('Could not find window.searchPageToken on page.');
    const pageToken = pageTokenMatch[1];

    const csrfMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (!csrfMatch) throw new Error('Could not find csrf-token meta tag on page.');
    const sessid = csrfMatch[1];

    const timestamp = Math.floor(Date.now() / 1000);
    const hmac = computeHMAC(id, timestamp, pageToken);

    const result = await page.evaluate(
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

    let json;
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
  search,
  resolveMagnet
};
