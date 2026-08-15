#!/usr/bin/env node

/**
 * Torznab-compatible server for ext.to, for use as a "Torznab (Custom)"
 * indexer in Prowlarr.
 *
 * ext.to sits behind Cloudflare Turnstile - see lib/browser.js for how we
 * get past that with Camoufox. Search results are scraped from
 * /browse/?q=... (see lib/browser.js + this file's search()). Magnet
 * resolution reuses the search-listing page's own magnet flow (see
 * lib/magnet.js) - no torrent detail page visit needed, just a fresh
 * /browse/ page load to get a valid page-nonce + csrf token, then the
 * torrent id carried through from the search results.
 *
 * Usage:
 *   API_KEY=yoursecret PORT=9117 node server.js
 */

import express from 'express';
import * as cheerio from 'cheerio';
import { resolveMagnetById } from './lib/magnet.js';
import { closeBrowser } from './lib/browser.js';
import { TTLCache } from './lib/cache.js';

const PORT = process.env.PORT || 9117;
const API_KEY = process.env.API_KEY || 'changeme';
const BASE = 'https://ext.to';

// Search results change (new uploads, seed counts) so keep the cache short.
// Magnet info hashes never change for a given torrent, so cache those much
// longer - avoids hitting ext.to again if Prowlarr re-grabs/retries.
const SEARCH_CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MS) || 5 * 60 * 1000;
const MAGNET_CACHE_TTL_MS = Number(process.env.MAGNET_CACHE_TTL_MS) || 60 * 60 * 1000;
const searchCache = new TTLCache(SEARCH_CACHE_TTL_MS);
const magnetCache = new TTLCache(MAGNET_CACHE_TTL_MS);

// Lazily imported here (not at module top) to avoid pulling in a second
// browser launch path when this file is loaded for testing.
const { gotoCleared } = await import('./lib/browser.js');

function checkKey(req, res) {
  if (req.query.apikey !== API_KEY) {
    res.status(401).send('Invalid apikey');
    return false;
  }
  return true;
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
  if (n.includes('tv') || n.includes('series')) return 5000;
  if (n.includes('anime')) return 5070;
  if (n.includes('music') || n.includes('audio')) return 3000;
  if (n.includes('game')) return 4050;
  if (n.includes('software') || n.includes('app')) return 4000;
  if (n.includes('book') || n.includes('ebook')) return 7000;
  if (n.includes('xxx') || n.includes('adult')) return 6000;
  if (n.includes('movie')) return 2000;
  return 8000;
}

function xmlEscape(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  })[c]);
}

const CAPS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="ext.to" strapline="ext.to Torznab proxy" />
  <limits max="100" default="50" />
  <searching>
    <search available="yes" supportedParams="q" />
    <movie-search available="yes" supportedParams="q" />
    <tv-search available="yes" supportedParams="q" />
  </searching>
  <categories>
    <category id="2000" name="Movies" />
    <category id="5000" name="TV" />
    <category id="5070" name="TV/Anime" />
    <category id="3000" name="Audio" />
    <category id="4000" name="PC" />
    <category id="6000" name="XXX" />
    <category id="7000" name="Books" />
    <category id="8000" name="Other" />
  </categories>
</caps>`;

async function search(q) {
  const cacheKey = q.toLowerCase().trim();
  const cached = searchCache.get(cacheKey);
  if (cached) {
    console.error(`[cache] search hit for q=${JSON.stringify(q)}`);
    return cached;
  }

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
        torrentId,
        size: parseSize(sizeText),
        seeds,
        leechers,
        category: mapCategory(categoryText),
        pubDate
      });
    });

    searchCache.set(cacheKey, items);
    return items;
  } finally {
    await page.close();
  }
}

function buildRss(req, items) {
  const selfUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const rows = items
    .map((it) => {
      const downloadUrl = `${req.protocol}://${req.get('host')}/download?apikey=${encodeURIComponent(API_KEY)}&id=${it.torrentId}`;
      const peers = it.seeds + it.leechers;
      return `  <item>
    <title>${xmlEscape(it.title)}</title>
    <guid isPermaLink="true">${xmlEscape(it.detailUrl)}</guid>
    <comments>${xmlEscape(it.detailUrl)}</comments>
    <pubDate>${it.pubDate.toUTCString()}</pubDate>
    <size>${it.size}</size>
    <link>${xmlEscape(downloadUrl)}</link>
    <category>${it.category}</category>
    <enclosure url="${xmlEscape(downloadUrl)}" length="${it.size}" type="application/x-bittorrent" />
    <torznab:attr name="category" value="${it.category}" />
    <torznab:attr name="size" value="${it.size}" />
    <torznab:attr name="seeders" value="${it.seeds}" />
    <torznab:attr name="peers" value="${peers}" />
  </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed">
<channel>
  <atom:link href="${xmlEscape(selfUrl)}" rel="self" type="application/rss+xml" />
  <title>ext.to</title>
${rows}
</channel>
</rss>`;
}

const app = express();

app.get('/api', async (req, res) => {
  const t = req.query.t;

  if (t === 'caps') {
    res.type('application/xml').send(CAPS_XML);
    return;
  }

  if (!checkKey(req, res)) return;

  if (t === 'search' || t === 'movie-search' || t === 'tv-search') {
    const q = req.query.q || '';
    try {
      const items = await search(q);
      res.type('application/xml').send(buildRss(req, items));
    } catch (err) {
      console.error('search error:', err);
      res.status(500).send(`Search failed: ${err.message}`);
    }
    return;
  }

  res.status(400).send(`Unsupported t=${t}`);
});

app.get('/download', async (req, res) => {
  if (!checkKey(req, res)) return;

  const id = parseInt(req.query.id, 10);
  if (!id) {
    res.status(400).send('Missing id param');
    return;
  }

  try {
    let magnet = magnetCache.get(id);
    if (magnet) {
      console.error(`[cache] magnet hit for id=${id}`);
    } else {
      magnet = await resolveMagnetById(id);
      magnetCache.set(id, magnet);
    }
    res.redirect(302, magnet);
  } catch (err) {
    console.error('download error:', err);
    res.status(500).send(`Download failed: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`ext.to Torznab server listening on http://localhost:${PORT}`);
  console.log(`Torznab URL for Prowlarr: http://localhost:${PORT}/api`);
  console.log(`API key: ${API_KEY}${API_KEY === 'changeme' ? ' (set API_KEY env var to something real!)' : ''}`);
});

async function shutdown() {
  console.log('Shutting down, closing browser...');
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
