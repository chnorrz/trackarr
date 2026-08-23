import * as cheerio from 'cheerio';
import { cfFetch } from '../lib/browser.js';
import { CATEGORIES } from '../lib/categories.js';
import { TTLCache } from '../lib/cache.js';
import { parseSize } from '../lib/parse.js';
import type { MagnetRef, Provider, SearchItem, SearchOptions, SearchResult } from '../lib/types.js';

const BASE = 'https://eztvx.to';
const DEPTH_CAP = 200;

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000;

// Search rows hide magnets behind a "Show links" button; POSTing
// layout=def_wlinks re-renders the same results with magnets inlined.
const magnetCache = new Map<string, string>();
const MAGNET_CACHE_MAX = 500;

function rememberMagnet(detailUrl: string, magnet: string): void {
  if (magnetCache.size >= MAGNET_CACHE_MAX) {
    const oldest = magnetCache.keys().next().value;
    if (oldest !== undefined) magnetCache.delete(oldest);
  }
  magnetCache.set(detailUrl, magnet);
}

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

    // Anchor text is truncated with "..."; the title attr holds the full
    // name plus a " (176 MB)" suffix, so size comes from there, not a <td>.
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
      seeds: 0,
      leechers: 0,
      category: CATEGORIES.TV,
      pubDate: new Date()
    });
  });

  return items;
}

async function searchByKeyword(q: string): Promise<SearchItem[]> {
  const cached = keywordSearchCache.get(q);
  if (cached) return cached;

  const searchUrl = `${BASE}/search/?q1=${encodeURIComponent(q)}`;

  // Required, not optional: the POST below fails unless the page already
  // sits on /search/. Result discarded - only the priming side effect matters.
  await cfFetch(searchUrl);

  const html = await cfFetch(searchUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ layout: 'def_wlinks' }).toString()
  });

  const items = parseSearchRows(html);

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
  // Comes back as a string in the JSON, not a number.
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

// The JSON API has no free-text search (blank-query path only) and is not
// behind Cloudflare, so it uses plain fetch rather than cfFetch.
const apiCache = new TTLCache<EztvApiResponse>(CACHE_TTL_MS);

async function browseLatest(opts: SearchOptions): Promise<SearchResult> {
  const limit = opts.limit;
  const cappedEnd = Math.min(opts.offset + limit, DEPTH_CAP);
  if (opts.offset >= cappedEnd) return { items: [], total: DEPTH_CAP };

  // Only lines up with the requested window while offset stays a multiple
  // of limit across one pagination sequence.
  const apiPage = Math.floor(opts.offset / limit) + 1;
  const apiUrl = `${BASE}/api/get-torrents?limit=${limit}&page=${apiPage}`;

  let data = apiCache.get(apiUrl);
  if (!data) {
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`eztv API request failed: ${res.status}`);
    data = (await res.json()) as EztvApiResponse;
    apiCache.set(apiUrl, data);
  }

  // Must run on cache hits too - rememberMagnet() repopulates the separate,
  // non-TTL magnetCache that download requests depend on.
  const items: SearchItem[] = (data.torrents || []).map((t) => {
    const title = t.title || t.filename;
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
  if (opts.categories && opts.categories.length > 0 && !opts.categories.includes(CATEGORIES.TV)) {
    return { items: [], total: 0 };
  }

  const trimmed = q.trim();
  if (!trimmed) return browseLatest(opts);

  const items = await searchByKeyword(trimmed);
  return { items: items.slice(opts.offset, opts.offset + opts.limit), total: items.length };
}

async function resolveMagnet({ url }: MagnetRef): Promise<string> {
  if (!url) throw new Error('eztv: resolveMagnet requires a url.');

  const cached = magnetCache.get(url);
  if (cached) return cached;

  const html = await cfFetch(url);
  const $ = cheerio.load(html);
  const magnet = $('a[href^="magnet:"]').first().attr('href');
  if (!magnet) throw new Error('Could not find a magnet link on the episode page.');
  return magnet;
}

export default {
  id: 'eztv',
  name: 'EZTV',
  keepAlive: { url: `${BASE}/search/?q1=the` },
  categories: [CATEGORIES.TV],
  search,
  resolveMagnet
} satisfies Provider;
