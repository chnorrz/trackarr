import * as cheerio from 'cheerio';
import { gotoCleared } from '../lib/browser.js';
import { CATEGORIES } from '../lib/categories.js';

const BASE = 'https://1337x.to';

function mapCategory(iconClass) {
  const c = (iconClass || '').toLowerCase();
  if (c.includes('tv')) return CATEGORIES.TV;
  if (c.includes('anime')) return CATEGORIES.TV_ANIME;
  if (c.includes('music')) return CATEGORIES.AUDIO;
  if (c.includes('games') || c.includes('apps')) return CATEGORIES.PC;
  if (c.includes('book')) return CATEGORIES.BOOKS;
  if (c.includes('xxx')) return CATEGORIES.XXX;
  if (c.includes('movie') || c.includes('hd') || c.includes('documentary')) return CATEGORIES.MOVIES;
  return CATEGORIES.OTHER;
}

// 1337x's size cell has the size text followed by a nested duplicate
// <span class="seeds">N</span> - strip nested elements to get just the
// size text node.
function directText($el) {
  return $el.clone().children().remove().end().text().trim();
}

async function search(q) {
  const searchUrl = `${BASE}/search/${encodeURIComponent(q)}/1/`;
  const page = await gotoCleared(searchUrl);
  try {
    const html = await page.content();
    const $ = cheerio.load(html);
    const items = [];

    $('table.table-list tbody > tr').each((_, el) => {
      const $tr = $(el);
      const nameCell = $tr.find('td.coll-1.name');
      const titleLink = nameCell.find('a[href^="/torrent/"]').first();
      const title = titleLink.text().trim();
      const href = titleLink.attr('href');
      if (!title || !href) return;
      const detailUrl = new URL(href, BASE).toString();

      const iconClass = nameCell.find('a.icon i').attr('class') || '';

      const seeds = parseInt($tr.find('td.coll-2.seeds').text().replace(/\D/g, ''), 10) || 0;
      const leechers = parseInt($tr.find('td.coll-3.leeches').text().replace(/\D/g, ''), 10) || 0;
      const sizeText = directText($tr.find('td.coll-4.size'));

      // 1337x only shows a relative-ish date string here (e.g. "May. 2nd
      // '18"), no exact-date attribute like ext.to's title attr - not
      // reliably parseable, so just use "now" as a best-effort pubDate.
      const pubDate = new Date();

      items.push({
        title,
        detailUrl,
        id: null,
        size: parseSize(sizeText),
        seeds,
        leechers,
        category: mapCategory(iconClass),
        pubDate
      });
    });

    return items;
  } finally {
    await page.close();
  }
}

function parseSize(str) {
  const m = /^([\d.,]+)\s*(B|KB|MB|GB|TB)$/i.exec((str || '').trim());
  if (!m) return 0;
  const num = parseFloat(m[1].replace(',', ''));
  const unit = m[2].toUpperCase();
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit];
  return Math.round(num * mult);
}

// 1337x embeds the magnet link directly on the torrent detail page - no
// AJAX/HMAC dance needed like ext.to.
async function resolveMagnet({ url }) {
  if (!url) throw new Error('1337x: resolveMagnet requires a url.');

  const page = await gotoCleared(url);
  try {
    const html = await page.content();
    const $ = cheerio.load(html);
    const magnet = $('a[href^="magnet:"]').first().attr('href');
    if (!magnet) throw new Error('Could not find a magnet link on the torrent page.');
    return magnet;
  } finally {
    await page.close();
  }
}

export default {
  id: '1337x',
  name: '1337x',
  search,
  resolveMagnet
};
