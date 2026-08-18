import * as cheerio from 'cheerio';
import { fetchCfProtectedPage, type FetchOptions } from '../lib/browser.js';
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
//
// Matched against the icon href via matchCategory() - same mechanism
// ext.to uses for its own category resolution (see providers/ext-to.ts).
// Each keyword is the *full* delimited path segment ("/sub/19/", both
// slashes), not the bare id - "/sub/19/" can never be a substring of
// "/sub/190/" (the character after "19" would have to be "/", not another
// digit), so this is exactly as precise as a dictionary lookup with none of
// the substring-collision risk a bare number would have. Since every
// keyword here is already a unique, fully-delimited id, rule order doesn't
// matter (unlike ext.to's rules, which do need specific-before-generic
// ordering for ambiguous text keywords).
const CATEGORY_RULES: CategoryRule[] = [
  // Movies
  [['/sub/66/'], CATEGORIES.MOVIES], // 3D
  [['/sub/73/'], CATEGORIES.MOVIES], // Bollywood
  [['/sub/2/'], CATEGORIES.MOVIES], // Divx/Xvid
  [['/sub/4/'], CATEGORIES.MOVIES], // Dubs/Dual Audio
  [['/sub/1/'], CATEGORIES.MOVIES], // DVD
  [['/sub/54/'], CATEGORIES.MOVIES], // h.264/x264
  [['/sub/42/'], CATEGORIES.MOVIES], // HD
  [['/sub/70/'], CATEGORIES.MOVIES], // HEVC/x265
  [['/sub/55/'], CATEGORIES.MOVIES], // Mp4
  [['/sub/3/'], CATEGORIES.MOVIES], // SVCD/VCD
  [['/sub/76/'], CATEGORIES.MOVIES], // UHD
  // TV
  [['/sub/74/'], CATEGORIES.TV], // Cartoon
  [['/sub/6/'], CATEGORIES.TV], // Divx/Xvid
  [['/sub/5/'], CATEGORIES.TV], // DVD
  [['/sub/41/'], CATEGORIES.TV], // HD
  [['/sub/71/'], CATEGORIES.TV], // HEVC/x265
  [['/sub/75/'], CATEGORIES.TV], // SD
  [['/sub/7/'], CATEGORIES.TV], // SVCD/VCD
  // Anime
  [['/sub/28/'], CATEGORIES.TV_ANIME],
  [['/sub/78/'], CATEGORIES.TV_ANIME], // Dual Audio
  [['/sub/79/'], CATEGORIES.TV_ANIME], // Dubbed
  [['/sub/81/'], CATEGORIES.TV_ANIME], // Raw
  [['/sub/80/'], CATEGORIES.TV_ANIME], // Subbed
  // Music
  [['/sub/69/'], CATEGORIES.AUDIO], // AAC
  [['/sub/53/'], CATEGORIES.AUDIO], // Album
  [['/sub/58/'], CATEGORIES.AUDIO], // Box Set
  [['/sub/68/'], CATEGORIES.AUDIO], // Concerts
  [['/sub/59/'], CATEGORIES.AUDIO], // Discography
  [['/sub/24/'], CATEGORIES.AUDIO], // DVD
  [['/sub/23/'], CATEGORIES.AUDIO], // Lossless
  [['/sub/22/'], CATEGORIES.AUDIO], // MP3
  [['/sub/27/'], CATEGORIES.AUDIO], // Other
  [['/sub/26/'], CATEGORIES.AUDIO], // Radio
  [['/sub/60/'], CATEGORIES.AUDIO], // Single
  [['/sub/25/'], CATEGORIES.AUDIO], // Video
  // XXX
  [['/sub/67/'], CATEGORIES.XXX], // Games
  [['/sub/51/'], CATEGORIES.XXX], // Hentai
  [['/sub/50/'], CATEGORIES.XXX], // Magazine
  [['/sub/49/'], CATEGORIES.XXX], // Picture
  [['/sub/48/'], CATEGORIES.XXX], // Video
  // Games
  [['/sub/72/'], CATEGORIES.CONSOLE_3DS],
  [['/sub/45/'], CATEGORIES.CONSOLE_NDS], // DS
  [['/sub/17/'], CATEGORIES.CONSOLE_OTHER],
  [['/sub/10/'], CATEGORIES.PC_GAMES], // PC Game
  [['/sub/43/'], CATEGORIES.CONSOLE_PS3],
  [['/sub/77/'], CATEGORIES.CONSOLE_PS4],
  [['/sub/12/'], CATEGORIES.CONSOLE_PSP],
  [['/sub/44/'], CATEGORIES.CONSOLE_WII],
  [['/sub/13/'], CATEGORIES.CONSOLE_XBOX],
  [['/sub/14/'], CATEGORIES.CONSOLE_XBOX360],
  // No dedicated Torznab id for these consoles - nearest catch-all bucket.
  [['/sub/16/'], CATEGORIES.CONSOLE_OTHER], // Dreamcast
  [['/sub/11/'], CATEGORIES.CONSOLE_OTHER], // PS2
  [['/sub/15/'], CATEGORIES.CONSOLE_OTHER], // PS1
  [['/sub/46/'], CATEGORIES.CONSOLE_OTHER], // GameCube
  [['/sub/82/'], CATEGORIES.CONSOLE_OTHER], // Switch
  // Apps
  [['/sub/56/'], CATEGORIES.PC_MOBILE_ANDROID],
  [['/sub/57/'], CATEGORIES.PC_MOBILE_IOS],
  [['/sub/19/'], CATEGORIES.PC_MAC],
  [['/sub/20/'], CATEGORIES.PC], // Linux
  [['/sub/21/'], CATEGORIES.PC], // Other
  [['/sub/18/'], CATEGORIES.PC], // PC Software
  // Other
  [['/sub/52/'], CATEGORIES.AUDIOBOOKS],
  [['/sub/36/'], CATEGORIES.BOOKS_EBOOK], // E-Books
  [['/sub/39/'], CATEGORIES.BOOKS], // Comics
  [['/sub/33/'], CATEGORIES.CONSOLE_OTHER], // Emulation
  [['/sub/37/'], CATEGORIES.OTHER], // Images
  [['/sub/38/'], CATEGORIES.OTHER], // Mobile Phone (not necessarily apps)
  [['/sub/47/'], CATEGORIES.PC], // Nulled Script
  [['/sub/40/'], CATEGORIES.OTHER],
  [['/sub/35/'], CATEGORIES.OTHER], // Sounds
  [['/sub/34/'], CATEGORIES.OTHER], // Tutorials
];

// Maps a Torznab category id to a 1337x listing path (either a top-level
// /cat/<Name>/ or a platform-specific /sub/<id>/) - used only for the
// blank-query "latest" path (a real keyword search isn't filtered
// server-side at all, see SearchOptions' doc comment). Ids with no
// dedicated 1337x subcategory (PS1/PS2/GameCube/Dreamcast/Switch, Linux
// apps, PC software) fall back to their nearest catch-all bucket. Stored
// with both slashes (not a bare fragment) - the page number that gets
// appended after it is the only piece any call site still supplies.
const CATEGORY_BROWSE: Partial<Record<number, string>> = {
  [CATEGORIES.MOVIES]: '/cat/Movies/',
  [CATEGORIES.TV]: '/cat/TV/',
  [CATEGORIES.TV_ANIME]: '/cat/Anime/',
  [CATEGORIES.AUDIO]: '/cat/Music/',
  [CATEGORIES.XXX]: '/cat/XXX/',
  [CATEGORIES.PC]: '/cat/Apps/',
  [CATEGORIES.PC_MAC]: '/sub/19/',
  [CATEGORIES.PC_MOBILE_IOS]: '/sub/57/',
  [CATEGORIES.PC_MOBILE_ANDROID]: '/sub/56/',
  [CATEGORIES.PC_GAMES]: '/sub/10/',
  [CATEGORIES.CONSOLE_NDS]: '/sub/45/',
  [CATEGORIES.CONSOLE_PSP]: '/sub/12/',
  [CATEGORIES.CONSOLE_WII]: '/sub/44/',
  [CATEGORIES.CONSOLE_XBOX]: '/sub/13/',
  [CATEGORIES.CONSOLE_XBOX360]: '/sub/14/',
  [CATEGORIES.CONSOLE_PS3]: '/sub/43/',
  [CATEGORIES.CONSOLE_3DS]: '/sub/72/',
  [CATEGORIES.CONSOLE_PS4]: '/sub/77/',
  [CATEGORIES.CONSOLE_OTHER]: '/sub/17/',
  [CATEGORIES.BOOKS_EBOOK]: '/sub/36/',
  [CATEGORIES.AUDIOBOOKS]: '/sub/52/',
  // 1337x has no bare "Books" listing, only the ebook/audiobook
  // subcategories - default an unspecific request to ebook.
  [CATEGORIES.BOOKS]: '/sub/36/',
  [CATEGORIES.OTHER]: '/cat/Other/'
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
const VIA_PROXY: FetchOptions = { proxy: '1337x' };

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

    // Trims the href down to just the "/sub/<id>/" segment, dropping the
    // trailing page number ("/sub/19/0/" -> "/sub/19/") - so what gets
    // passed to matchCategory() is exactly the meaningful part and nothing
    // else, making the lookup below a clean 1:1 match against CATEGORY_RULES
    // rather than a substring check against a longer, noisier string.
    const iconHref = (nameCell.find('a.icon').attr('href') || '').match(/^\/sub\/\d+\//)?.[0] || '';
    // Sub id is the only signal used - the icon CSS class it used to fall
    // back to drifted live (see NOTES.md section 3's "Category drift"):
    // TV rows started rendering the same class as HD movies. matchCategory()
    // itself defaults to CATEGORIES.OTHER when nothing matches, so an
    // unrecognized sub id (a future 1337x subcategory not yet listed) just
    // lands in Other rather than risk a wrong guess.
    const category = knownCategory ?? matchCategory(iconHref, CATEGORY_RULES);

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
  const html = await fetchCfProtectedPage(url, VIA_PROXY);
  return parseListing(html, knownCategory);
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
        NO_CAT_BROWSE.map((id) => fetchListingPage(`${BASE}${CATEGORY_BROWSE[id]}1/`, id))
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
      return fetchPagedWindow((sitePage) => fetchListingPage(`${BASE}${path}${sitePage}/`, id), paging);
    }

    return fetchMergedBrowse(
      targets.map(({ id, path }) => (sitePage: number) => fetchListingPage(`${BASE}${path}${sitePage}/`, id)),
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

  // Pure read - the magnet link is right there in the detail page's static
  // HTML, no POST needed - so this doesn't need a live page at all, just
  // the fast-path/caching fetchListingPage's real searches already get.
  const html = await fetchCfProtectedPage(url, VIA_PROXY);
  const $ = cheerio.load(html);
  const magnet = $('a[href^="magnet:"]').first().attr('href');
  if (!magnet) throw new Error('Could not find a magnet link on the torrent page.');
  return magnet;
}

export default {
  id: '1337x',
  name: '1337x',
  // Landing page is enough here - the challenge isn't path-specific, and it's
  // a cheaper page than a search. Needs the same proxy as everything else.
  keepAlive: { url: `${BASE}/`, proxy: '1337x' },
  // Every category CATEGORY_BROWSE can route, except BOOKS: that entry is
  // only a browse-routing fallback for an unspecific request, not a real
  // category with its own content (1337x only ever classifies items as the
  // more specific BOOKS_EBOOK/AUDIOBOOKS), so it shouldn't be advertised.
  categories: Object.keys(CATEGORY_BROWSE)
    .map(Number)
    .filter((id) => id !== CATEGORIES.BOOKS),
  search,
  resolveMagnet
} satisfies Provider;
