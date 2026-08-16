#!/usr/bin/env node

/**
 * Torznab-compatible server for scraper-unfriendly torrent trackers, for
 * use as "Torznab (Custom)" indexers in Prowlarr. One indexer per tracker,
 * all served from this one process (shared browser session pool + cache).
 *
 * Add a tracker: create providers/<id>.js exporting
 * { id, name, search(q), resolveMagnet({ id, url }) } (see providers/ for
 * examples), then register it in providers/index.js.
 *
 * Each provider gets its own Torznab endpoint at /<provider-id>/api, e.g.:
 *   http://localhost:9117/ext-to/api
 *   http://localhost:9117/1337x/api
 *
 * Usage:
 *   API_KEY=yoursecret PORT=9117 node server.js
 */

import express from 'express';
import { closeBrowser } from './lib/browser.js';
import { CATEGORIES_XML } from './lib/categories.js';
import { TTLCache } from './lib/cache.js';
import { providerMap } from './providers/index.js';

const PORT = process.env.PORT || 9117;
const API_KEY = process.env.API_KEY || 'changeme';

// Search results change (new uploads, seed counts) so keep the cache short.
// Magnet info hashes never change for a given torrent, so cache those much
// longer - avoids hitting the tracker again if Prowlarr re-grabs/retries.
const SEARCH_CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MS) || 5 * 60 * 1000;
const MAGNET_CACHE_TTL_MS = Number(process.env.MAGNET_CACHE_TTL_MS) || 60 * 60 * 1000;
const searchCache = new TTLCache(SEARCH_CACHE_TTL_MS);
const magnetCache = new TTLCache(MAGNET_CACHE_TTL_MS);

function checkKey(req, res) {
  if (req.query.apikey !== API_KEY) {
    res.status(401).send('Invalid apikey');
    return false;
  }
  return true;
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

function capsXml(provider) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <server title="${xmlEscape(provider.name)}" strapline="${xmlEscape(provider.name)} Torznab proxy" />
  <limits max="100" default="50" />
  <searching>
    <search available="yes" supportedParams="q" />
    <movie-search available="yes" supportedParams="q" />
    <tv-search available="yes" supportedParams="q" />
  </searching>
  <categories>
${CATEGORIES_XML}
  </categories>
</caps>`;
}

async function search(provider, q) {
  const cacheKey = `${provider.id}:${q.toLowerCase().trim()}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    console.error(`[cache] search hit for ${provider.id} q=${JSON.stringify(q)}`);
    return cached;
  }

  const items = await provider.search(q);
  // Never cache an empty result. A transient failure (proxy down, challenge
  // not cleared, markup change) would otherwise be frozen in for the full
  // TTL and keep being served after the underlying problem is fixed.
  if (items.length) searchCache.set(cacheKey, items);
  return items;
}

async function resolveMagnet(provider, ref) {
  const cacheKey = `${provider.id}:${ref.id ?? ref.url}`;
  const cached = magnetCache.get(cacheKey);
  if (cached) {
    console.error(`[cache] magnet hit for ${provider.id} ${JSON.stringify(ref)}`);
    return cached;
  }

  const magnet = await provider.resolveMagnet(ref);
  magnetCache.set(cacheKey, magnet);
  return magnet;
}

function buildRss(req, provider, items) {
  const selfUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const rows = items
    .map((it) => {
      const downloadUrl =
        `${req.protocol}://${req.get('host')}/${provider.id}/download?apikey=${encodeURIComponent(API_KEY)}` +
        (it.id != null ? `&id=${it.id}` : '') +
        `&url=${encodeURIComponent(it.detailUrl)}`;
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
  <title>${xmlEscape(provider.name)}</title>
${rows}
</channel>
</rss>`;
}

const app = express();

function getProvider(req, res) {
  const provider = providerMap[req.params.provider];
  if (!provider) {
    res.status(404).send(`Unknown provider: ${req.params.provider}`);
    return null;
  }
  return provider;
}

app.get('/:provider/api', async (req, res) => {
  const provider = getProvider(req, res);
  if (!provider) return;

  const t = req.query.t;

  if (t === 'caps') {
    res.type('application/xml').send(capsXml(provider));
    return;
  }

  if (!checkKey(req, res)) return;

  if (t === 'search' || t === 'movie-search' || t === 'tv-search') {
    const q = req.query.q || '';
    try {
      const items = await search(provider, q);
      res.type('application/xml').send(buildRss(req, provider, items));
    } catch (err) {
      console.error(`${provider.id} search error:`, err);
      res.status(500).send(`Search failed: ${err.message}`);
    }
    return;
  }

  res.status(400).send(`Unsupported t=${t}`);
});

app.get('/:provider/download', async (req, res) => {
  const provider = getProvider(req, res);
  if (!provider) return;

  if (!checkKey(req, res)) return;

  const id = req.query.id ? parseInt(req.query.id, 10) : null;
  const url = req.query.url || null;
  if (!id && !url) {
    res.status(400).send('Missing id or url param');
    return;
  }

  try {
    const magnet = await resolveMagnet(provider, { id, url });
    res.redirect(302, magnet);
  } catch (err) {
    console.error(`${provider.id} download error:`, err);
    res.status(500).send(`Download failed: ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`Torznab server listening on http://localhost:${PORT}`);
  for (const provider of Object.values(providerMap)) {
    console.log(`  ${provider.name}: http://localhost:${PORT}/${provider.id}/api`);
  }
  console.log(`API key: ${API_KEY}${API_KEY === 'changeme' ? ' (set API_KEY env var to something real!)' : ''}`);
});

async function shutdown() {
  console.log('Shutting down, closing browser...');
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
