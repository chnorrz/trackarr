import * as cheerio from 'cheerio';
import { cfFetch } from '../lib/browser.js';
import { CATEGORIES, matchCategory, type CategoryRule } from '../lib/categories.js';
import { fetchMergedBrowse, fetchPagedWindow } from '../lib/paging.js';
import { parseSize } from '../lib/parse.js';
import type { MagnetRef, Provider, ResolvedDownload, SearchItem, SearchOptions, SearchResult } from '../lib/types.js';

const BASE = 'https://1337x.to';

const SITE_PAGE_SIZE = 20;
const DEPTH_CAP = 200;

const CATEGORY_RULES: CategoryRule[] = [
  [['/sub/66/'], CATEGORIES.MOVIES],
  [['/sub/73/'], CATEGORIES.MOVIES],
  [['/sub/2/'], CATEGORIES.MOVIES],
  [['/sub/4/'], CATEGORIES.MOVIES],
  [['/sub/1/'], CATEGORIES.MOVIES],
  [['/sub/54/'], CATEGORIES.MOVIES],
  [['/sub/42/'], CATEGORIES.MOVIES],
  [['/sub/70/'], CATEGORIES.MOVIES],
  [['/sub/55/'], CATEGORIES.MOVIES],
  [['/sub/3/'], CATEGORIES.MOVIES],
  [['/sub/76/'], CATEGORIES.MOVIES],
  [['/sub/74/'], CATEGORIES.TV],
  [['/sub/6/'], CATEGORIES.TV],
  [['/sub/5/'], CATEGORIES.TV],
  [['/sub/41/'], CATEGORIES.TV],
  [['/sub/71/'], CATEGORIES.TV],
  [['/sub/75/'], CATEGORIES.TV],
  [['/sub/7/'], CATEGORIES.TV],
  [['/sub/28/'], CATEGORIES.TV_ANIME],
  [['/sub/78/'], CATEGORIES.TV_ANIME],
  [['/sub/79/'], CATEGORIES.TV_ANIME],
  [['/sub/81/'], CATEGORIES.TV_ANIME],
  [['/sub/80/'], CATEGORIES.TV_ANIME],
  [['/sub/69/'], CATEGORIES.AUDIO],
  [['/sub/53/'], CATEGORIES.AUDIO],
  [['/sub/58/'], CATEGORIES.AUDIO],
  [['/sub/68/'], CATEGORIES.AUDIO],
  [['/sub/59/'], CATEGORIES.AUDIO],
  [['/sub/24/'], CATEGORIES.AUDIO],
  [['/sub/23/'], CATEGORIES.AUDIO],
  [['/sub/22/'], CATEGORIES.AUDIO],
  [['/sub/27/'], CATEGORIES.AUDIO],
  [['/sub/26/'], CATEGORIES.AUDIO],
  [['/sub/60/'], CATEGORIES.AUDIO],
  [['/sub/25/'], CATEGORIES.AUDIO],
  [['/sub/67/'], CATEGORIES.XXX],
  [['/sub/51/'], CATEGORIES.XXX],
  [['/sub/50/'], CATEGORIES.XXX],
  [['/sub/49/'], CATEGORIES.XXX],
  [['/sub/48/'], CATEGORIES.XXX],
  [['/sub/72/'], CATEGORIES.CONSOLE_3DS],
  [['/sub/45/'], CATEGORIES.CONSOLE_NDS],
  [['/sub/17/'], CATEGORIES.CONSOLE_OTHER],
  [['/sub/10/'], CATEGORIES.PC_GAMES],
  [['/sub/43/'], CATEGORIES.CONSOLE_PS3],
  [['/sub/77/'], CATEGORIES.CONSOLE_PS4],
  [['/sub/12/'], CATEGORIES.CONSOLE_PSP],
  [['/sub/44/'], CATEGORIES.CONSOLE_WII],
  [['/sub/13/'], CATEGORIES.CONSOLE_XBOX],
  [['/sub/14/'], CATEGORIES.CONSOLE_XBOX360],
  [['/sub/16/'], CATEGORIES.CONSOLE_OTHER],
  [['/sub/11/'], CATEGORIES.CONSOLE_OTHER],
  [['/sub/15/'], CATEGORIES.CONSOLE_OTHER],
  [['/sub/46/'], CATEGORIES.CONSOLE_OTHER],
  [['/sub/82/'], CATEGORIES.CONSOLE_OTHER],
  [['/sub/56/'], CATEGORIES.PC_MOBILE_ANDROID],
  [['/sub/57/'], CATEGORIES.PC_MOBILE_IOS],
  [['/sub/19/'], CATEGORIES.PC_MAC],
  [['/sub/20/'], CATEGORIES.PC],
  [['/sub/21/'], CATEGORIES.PC],
  [['/sub/18/'], CATEGORIES.PC],
  [['/sub/52/'], CATEGORIES.AUDIOBOOKS],
  [['/sub/36/'], CATEGORIES.BOOKS_EBOOK],
  [['/sub/39/'], CATEGORIES.BOOKS],
  [['/sub/33/'], CATEGORIES.CONSOLE_OTHER],
  [['/sub/37/'], CATEGORIES.OTHER],
  [['/sub/38/'], CATEGORIES.OTHER],
  [['/sub/47/'], CATEGORIES.PC],
  [['/sub/40/'], CATEGORIES.OTHER],
  [['/sub/35/'], CATEGORIES.OTHER],
  [['/sub/34/'], CATEGORIES.OTHER],
];

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
  [CATEGORIES.BOOKS]: '/sub/36/',
  [CATEGORIES.OTHER]: '/cat/Other/'
};

// 1337x has no "all categories, newest first" listing, so a no-cat blank
// query is a fixed one-page-each snapshot, not a real paged browse.
const NO_CAT_BROWSE: number[] = [CATEGORIES.MOVIES, CATEGORIES.TV, CATEGORIES.AUDIO, CATEGORIES.OTHER];

interface ListingPage {
  items: SearchItem[];
  totalHint?: number;
}

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

    const iconHref = (nameCell.find('a.icon').attr('href') || '').match(/^\/sub\/\d+\//)?.[0] || '';
    // Sub id only: the icon CSS class drifted live (TV rows started
    // rendering the same class as HD movies), so it can't be trusted.
    const category = knownCategory ?? matchCategory(iconHref, CATEGORY_RULES);

    const seeds = parseInt($tr.find('td.coll-2.seeds').text().replace(/\D/g, ''), 10) || 0;
    const leechers = parseInt($tr.find('td.coll-3.leeches').text().replace(/\D/g, ''), 10) || 0;
    // Size cell contains a nested duplicate <span class="seeds">N</span> -
    // strip child elements to get just the size text node.
    const sizeText = $tr.find('td.coll-4.size').clone().children().remove().end().text().trim();

    // Only a fuzzy relative date is rendered (e.g. "May. 2nd '18"), with no
    // exact-date attribute anywhere - not reliably parseable, so use now.
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

  // No exact result count is rendered anywhere, only a "last page" link -
  // estimate the total from its page number.
  let totalHint: number | undefined;
  const lastHref = $('li.last a').first().attr('href');
  const lastPageMatch = lastHref ? lastHref.match(/\/(\d+)\/?$/) : null;
  if (lastPageMatch && lastPageMatch[1]) totalHint = parseInt(lastPageMatch[1], 10) * SITE_PAGE_SIZE;

  return { items, totalHint };
}

async function fetchListingPage(url: string, knownCategory?: number): Promise<ListingPage> {
  // 1337x.to bans our IPv4 but not IPv6; routing is via DOMAIN_OVER_PROXY.
  const html = await (await cfFetch(url)).text();
  return parseListing(html, knownCategory);
}

async function search(q: string, opts: SearchOptions): Promise<SearchResult> {
  const trimmed = q.trim();
  const paging = { offset: opts.offset, limit: opts.limit, sitePageSize: SITE_PAGE_SIZE, depthCap: DEPTH_CAP };

  if (!trimmed) {
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
    if (targets.length === 0) return { items: [], total: 0 };
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

async function resolveMagnet({ url }: MagnetRef): Promise<ResolvedDownload> {
  if (!url) throw new Error('1337x: resolveMagnet requires a url.');

  const html = await (await cfFetch(url)).text();
  const $ = cheerio.load(html);
  const magnet = $('a[href^="magnet:"]').first().attr('href');
  if (!magnet) throw new Error('Could not find a magnet link on the torrent page.');
  return { kind: 'magnet', magnet };
}

export default {
  id: '1337x',
  name: '1337x',
  keepAlive: { url: `${BASE}/` },
  categories: Object.keys(CATEGORY_BROWSE)
    .map(Number)
    .filter((id) => id !== CATEGORIES.BOOKS),
  search,
  resolveMagnet
} satisfies Provider;
