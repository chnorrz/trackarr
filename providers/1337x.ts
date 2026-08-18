import * as cheerio from 'cheerio';
import { gotoCleared, type GotoOptions } from '../lib/browser.js';
import { CATEGORIES, matchCategory, type CategoryRule } from '../lib/categories.js';
import { fetchMergedBrowse, fetchPagedWindow } from '../lib/paging.js';
import { parseSize } from '../lib/parse.js';
import type { MagnetRef, Provider, SearchItem, SearchOptions, SearchResult } from '../lib/types.js';

const BASE = 'https://1337x.to';

// Fixed page size for every listing (search, /cat/, /sub/) - 1337x doesn't
// support a page_size param like ext.to does.
const SITE_PAGE_SIZE = 20;
// How deep into 1337x's own catalog trackarr will ever page for one query.
// This, not <opensearch:totalResults> (an estimate here anyway - see
// below), is what actually stops Prowlarr's pagination - see server.ts.
const DEPTH_CAP = 200;

// Each row's icon is a link to that item's own /sub/<id>/ subcategory page.
// These numeric ids are 1337x's actual internal taxonomy (read straight off
// the site's own category sidebars) and are the primary signal for
// classifying a row - unlike the icon *class* names, which collide (TV
// episodes and HD movies both render "flaticon-hd" on the current site,
// several Movies/TV/Anime subcats share "flaticon-divx", etc) and drift
// over time (a "flaticon-lossless" class showed up for Music that no older
// rule accounted for).
const SUB_ID_CATEGORY: Partial<Record<number, number>> = {
  // Movies
  66: CATEGORIES.MOVIES, // 3D
  73: CATEGORIES.MOVIES, // Bollywood
  2: CATEGORIES.MOVIES, // Divx/Xvid
  4: CATEGORIES.MOVIES, // Dubs/Dual Audio
  1: CATEGORIES.MOVIES, // DVD
  54: CATEGORIES.MOVIES, // h.264/x264
  42: CATEGORIES.MOVIES, // HD
  70: CATEGORIES.MOVIES, // HEVC/x265
  55: CATEGORIES.MOVIES, // Mp4
  3: CATEGORIES.MOVIES, // SVCD/VCD
  76: CATEGORIES.MOVIES, // UHD
  // TV
  74: CATEGORIES.TV, // Cartoon
  6: CATEGORIES.TV, // Divx/Xvid
  5: CATEGORIES.TV, // DVD
  41: CATEGORIES.TV, // HD
  71: CATEGORIES.TV, // HEVC/x265
  75: CATEGORIES.TV, // SD
  7: CATEGORIES.TV, // SVCD/VCD
  // Anime
  28: CATEGORIES.TV_ANIME,
  78: CATEGORIES.TV_ANIME, // Dual Audio
  79: CATEGORIES.TV_ANIME, // Dubbed
  81: CATEGORIES.TV_ANIME, // Raw
  80: CATEGORIES.TV_ANIME, // Subbed
  // Music
  69: CATEGORIES.AUDIO, // AAC
  53: CATEGORIES.AUDIO, // Album
  58: CATEGORIES.AUDIO, // Box Set
  68: CATEGORIES.AUDIO, // Concerts
  59: CATEGORIES.AUDIO, // Discography
  24: CATEGORIES.AUDIO, // DVD
  23: CATEGORIES.AUDIO, // Lossless
  22: CATEGORIES.AUDIO, // MP3
  27: CATEGORIES.AUDIO, // Other
  26: CATEGORIES.AUDIO, // Radio
  60: CATEGORIES.AUDIO, // Single
  25: CATEGORIES.AUDIO, // Video
  // XXX
  67: CATEGORIES.XXX, // Games
  51: CATEGORIES.XXX, // Hentai
  50: CATEGORIES.XXX, // Magazine
  49: CATEGORIES.XXX, // Picture
  48: CATEGORIES.XXX, // Video
  // Games
  72: CATEGORIES.CONSOLE_3DS,
  45: CATEGORIES.CONSOLE_NDS, // DS
  17: CATEGORIES.CONSOLE_OTHER,
  10: CATEGORIES.PC_GAMES, // PC Game
  43: CATEGORIES.CONSOLE_PS3,
  77: CATEGORIES.CONSOLE_PS4,
  12: CATEGORIES.CONSOLE_PSP,
  44: CATEGORIES.CONSOLE_WII,
  13: CATEGORIES.CONSOLE_XBOX,
  14: CATEGORIES.CONSOLE_XBOX360,
  // No dedicated Torznab id for these consoles - nearest catch-all bucket.
  16: CATEGORIES.CONSOLE_OTHER, // Dreamcast
  11: CATEGORIES.CONSOLE_OTHER, // PS2
  15: CATEGORIES.CONSOLE_OTHER, // PS1
  46: CATEGORIES.CONSOLE_OTHER, // GameCube
  82: CATEGORIES.CONSOLE_OTHER, // Switch
  // Apps
  56: CATEGORIES.PC_MOBILE_ANDROID,
  57: CATEGORIES.PC_MOBILE_IOS,
  19: CATEGORIES.PC_MAC,
  20: CATEGORIES.PC, // Linux
  21: CATEGORIES.PC, // Other
  18: CATEGORIES.PC, // PC Software
  // Other
  52: CATEGORIES.AUDIOBOOKS,
  36: CATEGORIES.BOOKS_EBOOK, // E-Books
  39: CATEGORIES.BOOKS, // Comics
  33: CATEGORIES.CONSOLE_OTHER, // Emulation
  37: CATEGORIES.OTHER, // Images
  38: CATEGORIES.OTHER, // Mobile Phone (not necessarily apps)
  47: CATEGORIES.PC, // Nulled Script
  40: CATEGORIES.OTHER,
  35: CATEGORIES.OTHER, // Sounds
  34: CATEGORIES.OTHER // Tutorials
};

// Fallback only for a row whose sub id isn't in SUB_ID_CATEGORY (a future
// subcategory 1337x adds that we haven't listed) or has no icon href at
// all. Order matters - first match wins, and "hd" must stay below "tv" so
// an HD TV episode isn't filed as a movie if it ever falls through to here.
const CATEGORY_RULES: CategoryRule[] = [
  [['tv'], CATEGORIES.TV],
  [['anime'], CATEGORIES.TV_ANIME],
  [['music', 'lossless'], CATEGORIES.AUDIO],
  [['games', 'apps'], CATEGORIES.PC],
  [['audiobook'], CATEGORIES.AUDIOBOOKS],
  [['book'], CATEGORIES.BOOKS],
  [['xxx'], CATEGORIES.XXX],
  [['movie', 'hd', 'documentary'], CATEGORIES.MOVIES]
];

// Maps a Torznab category id to a 1337x listing path (either a top-level
// /cat/<Name>/ or a platform-specific /sub/<id>/) - used only for the
// blank-query "latest" path (a real keyword search isn't filtered
// server-side at all, see SearchOptions' doc comment). Ids with no
// dedicated 1337x subcategory (PS1/PS2/GameCube/Dreamcast/Switch, Linux
// apps, PC software) fall back to their nearest catch-all bucket.
const CATEGORY_BROWSE: Partial<Record<number, string>> = {
  [CATEGORIES.MOVIES]: 'cat/Movies',
  [CATEGORIES.TV]: 'cat/TV',
  [CATEGORIES.TV_ANIME]: 'cat/Anime',
  [CATEGORIES.AUDIO]: 'cat/Music',
  [CATEGORIES.XXX]: 'cat/XXX',
  [CATEGORIES.PC]: 'cat/Apps',
  [CATEGORIES.PC_MAC]: 'sub/19',
  [CATEGORIES.PC_MOBILE_IOS]: 'sub/57',
  [CATEGORIES.PC_MOBILE_ANDROID]: 'sub/56',
  [CATEGORIES.PC_GAMES]: 'sub/10',
  [CATEGORIES.CONSOLE_NDS]: 'sub/45',
  [CATEGORIES.CONSOLE_PSP]: 'sub/12',
  [CATEGORIES.CONSOLE_WII]: 'sub/44',
  [CATEGORIES.CONSOLE_XBOX]: 'sub/13',
  [CATEGORIES.CONSOLE_XBOX360]: 'sub/14',
  [CATEGORIES.CONSOLE_PS3]: 'sub/43',
  [CATEGORIES.CONSOLE_3DS]: 'sub/72',
  [CATEGORIES.CONSOLE_PS4]: 'sub/77',
  [CATEGORIES.CONSOLE_OTHER]: 'sub/17',
  [CATEGORIES.BOOKS_EBOOK]: 'sub/36',
  [CATEGORIES.AUDIOBOOKS]: 'sub/52',
  // 1337x has no bare "Books" listing, only the ebook/audiobook
  // subcategories - default an unspecific request to ebook.
  [CATEGORIES.BOOKS]: 'sub/36',
  [CATEGORIES.OTHER]: 'cat/Other'
};

// 1337x has no "all categories, newest first" listing (unlike ext.to/EZTV),
// so a blank query with no cat at all can't be a real paged browse. Matches
// Prowlarr's own reference 1337x indexer definition (definitions/v11/
// 1337x.yml in Prowlarr/Indexers): a fixed, single-page-each snapshot of
// Movies/TV/Music/Other, concatenated in that order with no cross-category
// date re-sort - cheap, and known to work in practice, at the cost of not
// supporting real offset/limit depth for this specific case.
const NO_CAT_BROWSE: number[] = [CATEGORIES.MOVIES, CATEGORIES.TV, CATEGORIES.AUDIO, CATEGORIES.OTHER];

// 1337x has banned our IPv4 address but not our IPv6 one, and the container
// has no IPv6 of its own - so ask to route through the host proxy (see
// NOTES.md). Passing the provider id lets PROXY_PROVIDERS target it. Falls
// back to a direct connection when no proxy is configured.
const VIA_PROXY: GotoOptions = { proxy: '1337x' };

interface ListingPage {
  items: SearchItem[];
  totalHint?: number;
}

// knownCategory: set when this HTML came from a browse fetch of a specific
// category's own listing page (e.g. cat/TV/1/) - the URL we chose already
// tells us the category, which is more reliable than re-deriving it from
// the row's icon, so every item is stamped with it directly and per-row
// detection is skipped entirely. Left undefined for real keyword search,
// where results mix every category on one page and per-row detection is
// unavoidable.
function parseListing(html: string, knownCategory?: number): ListingPage {
  const $ = cheerio.load(html);
  const items: SearchItem[] = [];

  $('table.table-list tbody > tr').each((_, el) => {
    const $tr = $(el);
    const nameCell = $tr.find('td.coll-1.name');
    const titleLink = nameCell.find('a[href^="/torrent/"]').first();
    const title = titleLink.text().trim();
    const href = titleLink.attr('href');
    if (!title || !href) return;
    const detailUrl = new URL(href, BASE).toString();

    const iconClass = nameCell.find('a.icon i').attr('class') || '';
    const iconHref = nameCell.find('a.icon').attr('href') || '';
    const subId = parseInt((iconHref.match(/^\/sub\/(\d+)\//) || [])[1] || '', 10);
    const category = knownCategory ?? SUB_ID_CATEGORY[subId] ?? matchCategory(iconClass, CATEGORY_RULES);

    const seeds = parseInt($tr.find('td.coll-2.seeds').text().replace(/\D/g, ''), 10) || 0;
    const leechers = parseInt($tr.find('td.coll-3.leeches').text().replace(/\D/g, ''), 10) || 0;
    // 1337x's size cell has the size text followed by a nested duplicate
    // <span class="seeds">N</span> - strip nested elements to get just
    // the size text node.
    const sizeText = $tr.find('td.coll-4.size').clone().children().remove().end().text().trim();

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
      category,
      pubDate
    });
  });

  // 1337x has no exact result count anywhere on the page - only a link to
  // the last page (e.g. <li class="last"><a href="/cat/TV/150/">Last</a>
  // </li>). Estimate the total from that rather than leaving it undefined;
  // it's only used for opensearch:totalResults, spec-compliance polish
  // that Prowlarr itself never parses (see server.ts) - actual pagination
  // correctness comes from fetchPagedWindow's short-page detection.
  let totalHint: number | undefined;
  const lastHref = $('li.last a').first().attr('href');
  const lastPageMatch = lastHref ? lastHref.match(/\/(\d+)\/?$/) : null;
  if (lastPageMatch && lastPageMatch[1]) totalHint = parseInt(lastPageMatch[1], 10) * SITE_PAGE_SIZE;

  return { items, totalHint };
}

async function fetchListingPage(url: string, knownCategory?: number): Promise<ListingPage> {
  const page = await gotoCleared(url, VIA_PROXY);
  try {
    return parseListing(await page.content(), knownCategory);
  } finally {
    await page.close();
  }
}

async function search(q: string, opts: SearchOptions): Promise<SearchResult> {
  const trimmed = q.trim();
  const paging = { offset: opts.offset, limit: opts.limit, sitePageSize: SITE_PAGE_SIZE, depthCap: DEPTH_CAP };

  if (!trimmed) {
    // Blank query ("Test" button, and every routine RSS/search sync - see
    // server.ts): browse the requested category/categories' latest uploads
    // instead of a keyword search. Both /cat/ and /sub/ listings sort
    // newest-first already, no explicit sort param needed.
    if (!opts.categories || opts.categories.length === 0) {
      const pages = await Promise.all(
        NO_CAT_BROWSE.map((id) => fetchListingPage(`${BASE}/${CATEGORY_BROWSE[id]}/1/`, id))
      );
      const items = pages.flatMap((p) => p.items);
      return { items: items.slice(opts.offset, opts.offset + opts.limit), total: items.length };
    }

    const targets = opts.categories
      .map((id) => ({ id, path: CATEGORY_BROWSE[id] }))
      .filter((t): t is { id: number; path: string } => t.path !== undefined);
    if (targets.length === 0) return { items: [], total: 0 }; // all requested cats unknown to 1337x
    if (targets.length === 1) {
      const { id, path } = targets[0]!;
      return fetchPagedWindow((sitePage) => fetchListingPage(`${BASE}/${path}/${sitePage}/`, id), paging);
    }

    return fetchMergedBrowse(
      targets.map(({ id, path }) => (sitePage: number) => fetchListingPage(`${BASE}/${path}/${sitePage}/`, id)),
      paging
    );
  }

  const filter = opts.categories?.length ? (item: SearchItem) => opts.categories?.includes(item.category) ?? true : undefined;
  return fetchPagedWindow(
    (sitePage) => fetchListingPage(`${BASE}/search/${encodeURIComponent(trimmed)}/${sitePage}/`),
    { ...paging, filter }
  );
}

// 1337x embeds the magnet link directly on the torrent detail page - no
// AJAX/HMAC dance needed like ext.to.
async function resolveMagnet({ url }: MagnetRef): Promise<string> {
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
  categories: [
    CATEGORIES.MOVIES,
    CATEGORIES.TV,
    CATEGORIES.TV_ANIME,
    CATEGORIES.AUDIO,
    CATEGORIES.XXX,
    CATEGORIES.PC,
    CATEGORIES.PC_MAC,
    CATEGORIES.PC_MOBILE_IOS,
    CATEGORIES.PC_MOBILE_ANDROID,
    CATEGORIES.PC_GAMES,
    CATEGORIES.CONSOLE_NDS,
    CATEGORIES.CONSOLE_PSP,
    CATEGORIES.CONSOLE_WII,
    CATEGORIES.CONSOLE_XBOX,
    CATEGORIES.CONSOLE_XBOX360,
    CATEGORIES.CONSOLE_PS3,
    CATEGORIES.CONSOLE_3DS,
    CATEGORIES.CONSOLE_PS4,
    CATEGORIES.CONSOLE_OTHER,
    CATEGORIES.BOOKS_EBOOK,
    CATEGORIES.AUDIOBOOKS,
    CATEGORIES.OTHER
  ],
  search,
  resolveMagnet
} satisfies Provider;
