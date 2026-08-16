import * as cheerio from 'cheerio';
import { gotoCleared } from '../lib/browser.js';
import { CATEGORIES, matchCategory } from '../lib/categories.js';
import { parseSize } from '../lib/parse.js';

const BASE = 'https://1337x.to';

// Matched against the row's icon class ("flaticon-movies", "flaticon-hd").
// Order matters - first match wins, and "hd" must stay below "tv" so an HD
// TV episode isn't filed as a movie.
const CATEGORY_RULES = [
  [['tv'], CATEGORIES.TV],
  [['anime'], CATEGORIES.TV_ANIME],
  [['music'], CATEGORIES.AUDIO],
  [['games', 'apps'], CATEGORIES.PC],
  [['book'], CATEGORIES.BOOKS],
  [['xxx'], CATEGORIES.XXX],
  [['movie', 'hd', 'documentary'], CATEGORIES.MOVIES]
];

// 1337x's size cell has the size text followed by a nested duplicate
// <span class="seeds">N</span> - strip nested elements to get just the
// size text node.
function directText($el) {
  return $el.clone().children().remove().end().text().trim();
}

// 1337x has banned our IPv4 address but not our IPv6 one, and the container
// has no IPv6 of its own - so ask to route through the host proxy (see
// NOTES.md). Passing the provider id lets PROXY_PROVIDERS target it. Falls
// back to a direct connection when no proxy is configured.
const VIA_PROXY = { proxy: '1337x' };

async function search(q) {
  const searchUrl = `${BASE}/search/${encodeURIComponent(q)}/1/`;
  const page = await gotoCleared(searchUrl, VIA_PROXY);
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
        category: matchCategory(iconClass, CATEGORY_RULES),
        pubDate
      });
    });

    return items;
  } finally {
    await page.close();
  }
}

// 1337x embeds the magnet link directly on the torrent detail page - no
// AJAX/HMAC dance needed like ext.to.
async function resolveMagnet({ url }) {
  if (!url) throw new Error('1337x: resolveMagnet requires a url.');

  const page = await gotoCleared(url, VIA_PROXY);
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
  // Landing page is enough here - the challenge isn't path-specific, and it's
  // a cheaper page than a search. Needs the same proxy as everything else.
  keepAlive: { url: `${BASE}/`, proxy: '1337x' },
  search,
  resolveMagnet
};
