import * as cheerio from 'cheerio';
import { gotoCleared } from '../lib/browser.js';
import { CATEGORIES } from '../lib/categories.js';
import { parseSize } from '../lib/parse.js';

const BASE = 'https://eztvx.to';

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
// pattern as ext.to's magnet API - see providers/ext-to.js) means search()
// can capture every result's magnet in the same request that finds it,
// instead of needing a separate detail-page visit per grab like 1337x.
//
// resolveMagnet() still exists and still works standalone (a fresh detail-
// page visit, same shape as 1337x) - it's the fallback for when a result's
// magnet has aged out of magnetCache below (e.g. the process restarted
// between search and grab).
const magnetCache = new Map();
const MAGNET_CACHE_MAX = 500;

function rememberMagnet(detailUrl, magnet) {
  if (magnetCache.size >= MAGNET_CACHE_MAX) {
    magnetCache.delete(magnetCache.keys().next().value);
  }
  magnetCache.set(detailUrl, magnet);
}

async function search(q) {
  const searchUrl = `${BASE}/search/?q1=${encodeURIComponent(q)}`;
  const page = await gotoCleared(searchUrl);
  try {
    // Reveal the per-row magnet links (see comment above). Runs inside the
    // page via fetch, not Node's own fetch, for the same TLS/cookie-
    // consistency reason as ext.to's magnet POST.
    const wlinks = await page.evaluate(async (url) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ layout: 'def_wlinks' }).toString()
      });
      return { status: res.status, text: await res.text() };
    }, searchUrl);

    // Fall back to the plain (magnet-less) page rather than fail the whole
    // search if the reveal POST itself has a problem - resolveMagnet()'s
    // detail-page fallback still covers grabs either way.
    const html = wlinks.status === 200 ? wlinks.text : await page.content();
    const $ = cheerio.load(html);
    const items = [];

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
      // button cell (before the reveal-click above).
      const titleAttr = titleLink.attr('title') || titleLink.text();
      const sizeMatch = titleAttr.match(/\(([\d.,]+\s*(?:B|KB|MB|GB|TB))\)\s*$/i);
      const title = (sizeMatch ? titleAttr.slice(0, sizeMatch.index) : titleAttr).trim();
      const size = sizeMatch ? parseSize(sizeMatch[1]) : 0;

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
  } finally {
    await page.close();
  }
}

async function resolveMagnet({ url }) {
  if (!url) throw new Error('eztv: resolveMagnet requires a url.');

  const cached = magnetCache.get(url);
  if (cached) return cached;

  // Fallback: magnet is also embedded directly on the episode detail page -
  // no AJAX/HMAC dance, same as 1337x.
  const page = await gotoCleared(url);
  try {
    const html = await page.content();
    const $ = cheerio.load(html);
    const magnet = $('a[href^="magnet:"]').first().attr('href');
    if (!magnet) throw new Error('Could not find a magnet link on the episode page.');
    return magnet;
  } finally {
    await page.close();
  }
}

export default {
  id: 'eztv',
  name: 'EZTV',
  keepAlive: { url: `${BASE}/` },
  testQuery: 'MeGusta',
  search,
  resolveMagnet
};
