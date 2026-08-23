import * as cheerio from 'cheerio';
import { applyFilters, type FilterSpec } from './filters.js';
import { buildQueryString, type InputsBlock } from './inputs.js';
import { renderTemplate, type DownloadUri, type TemplateContext } from './template.js';

// Resolves the wiki's "Download" section: when a listing doesn't already
// carry a usable magnet/download link, this walks the documented
// before -> selectors -> infohash chain to find one.
//
// UNTESTED against any real live site: none of this repo's checked-in
// definitions (kickasstorrents-to.yml) exercise a download block at all -
// its own `download:` field selects a magnet URI directly from the listing,
// so this file's logic never runs for it. See NOTES.md section 20.

export interface SimpleSelectorSpec {
  selector?: string;
  attribute?: string;
  usebeforeresponse?: boolean;
  filters?: FilterSpec[];
}

export interface BeforeBlock {
  path?: string;
  pathselector?: SimpleSelectorSpec;
  method?: string;
  inputs?: InputsBlock;
  queryseparator?: string;
}

export interface InfoHashBlock {
  hash: SimpleSelectorSpec;
  title: SimpleSelectorSpec;
  usebeforeresponse?: boolean;
}

export interface DownloadBlockDef {
  method?: string;
  before?: BeforeBlock;
  selectors?: SimpleSelectorSpec[];
  infohash?: InfoHashBlock;
  headers?: Record<string, string[]>;
}

export interface Fetcher {
  (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<string>;
}

// The one hardcoded piece of this module: infohash-built magnets need a
// tracker list and none is specified anywhere in the format. Sourced from a
// magnet URI actually captured live this session (a real EZTV row, not
// invented), rather than an arbitrary public list.
const DEFAULT_MAGNET_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://tracker.dler.org:6969/announce'
];

function buildDownloadUri(url: string): DownloadUri {
  const u = new URL(url);
  const query: Record<string, string> = {};
  for (const [k, v] of u.searchParams) query[k] = v;
  return {
    AbsoluteUri: u.toString(),
    AbsolutePath: u.pathname,
    Scheme: u.protocol.replace(':', ''),
    Host: u.hostname,
    Port: u.port || (u.protocol === 'https:' ? '443' : '80'),
    PathAndQuery: u.pathname + u.search,
    Query: query
  };
}

function extractFromHtml(html: string, spec: SimpleSelectorSpec): string {
  if (!spec.selector) return '';
  const $ = cheerio.load(html);
  const found = $(spec.selector).first();
  if (found.length === 0) return '';
  const raw = spec.attribute !== undefined ? (found.attr(spec.attribute) ?? '') : found.text().trim();
  return applyFilters(spec.filters, raw);
}

// Exported so the adapter can build a magnet directly from a bare
// fields.infohash value at listing time, without going through the whole
// download block (fields.infohash is a plain flat field - distinct from
// download.infohash's {hash,title} sub-selector mechanism above).
export function buildMagnetFromInfohash(hash: string, title: string): string {
  const params = [`xt=urn:btih:${hash}`, `dn=${encodeURIComponent(title)}`, ...DEFAULT_MAGNET_TRACKERS.map((t) => `tr=${encodeURIComponent(t)}`)];
  return `magnet:?${params.join('&')}`;
}

export interface ResolveOptions {
  definition: Record<string, unknown>;
  /** The item's own captured download link (search results' `download:`
   * field), or the detail page URL if no download link was captured. This
   * seeds .DownloadUri and is also the page selectors read from by default. */
  downloadUri: string;
  /** The item's own title, for .Result.title inside before.inputs templates
   * and as the infohash magnet's &dn= fallback if infohash.title has no match. */
  itemTitle: string;
  fetch: Fetcher;
}

export async function resolveCardigannDownload(opts: ResolveOptions): Promise<string> {
  if (opts.downloadUri.startsWith('magnet:')) return opts.downloadUri;

  const download = (opts.definition.download as DownloadBlockDef | undefined) ?? undefined;
  const downloadUriCtx = buildDownloadUri(opts.downloadUri);
  const ctx: TemplateContext = {
    Keywords: '',
    Query: {},
    Categories: [],
    Config: {},
    Result: { title: opts.itemTitle },
    DownloadUri: downloadUriCtx
  };

  if (!download) {
    // No download block declared: the item's own captured link is assumed
    // to be a real page containing a magnet, same fallback our hand-written
    // providers (ext-to/1337x/eztv) all use on their detail pages.
    const html = await opts.fetch(opts.downloadUri);
    const magnet = extractFromHtml(html, { selector: 'a[href^="magnet:"]', attribute: 'href' });
    if (magnet) return magnet;
    throw new Error(`Cardigann: no download block and no magnet link found on ${opts.downloadUri}`);
  }

  let beforeResponseBody: string | undefined;

  if (download.before) {
    let beforePath = download.before.path;
    if (!beforePath && download.before.pathselector) {
      // The wiki's own "thankyou link" example: the pathselector's source
      // page is the item's captured download/detail page, fetched fresh.
      const sourceHtml = await opts.fetch(opts.downloadUri);
      beforePath = extractFromHtml(sourceHtml, download.before.pathselector);
    }
    if (!beforePath) {
      throw new Error(`Cardigann: download.before resolved to no path for ${opts.downloadUri}`);
    }

    const method = (download.before.method ?? 'get').toUpperCase();
    const renderedPath = renderTemplate(beforePath, ctx);
    const qs = buildQueryString(download.before.inputs, ctx, { queryseparator: download.before.queryseparator });
    const beforeUrl = new URL(renderedPath, opts.downloadUri);

    if (method === 'GET') {
      if (qs) beforeUrl.search = beforeUrl.search ? `${beforeUrl.search}&${qs}` : qs;
      beforeResponseBody = await opts.fetch(beforeUrl.toString());
    } else {
      beforeResponseBody = await opts.fetch(beforeUrl.toString(), {
        method,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: qs
      });
    }
  }

  let defaultResponseBody: string | undefined;
  const bodyFor = async (usebeforeresponse: boolean | undefined): Promise<string> => {
    if (usebeforeresponse) {
      if (beforeResponseBody === undefined) throw new Error('Cardigann: usebeforeresponse:true but no download.before block ran');
      return beforeResponseBody;
    }
    if (defaultResponseBody === undefined) defaultResponseBody = await opts.fetch(opts.downloadUri);
    return defaultResponseBody;
  };

  for (const selector of download.selectors ?? []) {
    const html = await bodyFor(selector.usebeforeresponse);
    const resolved = extractFromHtml(html, selector);
    if (!resolved) continue;
    if (resolved.startsWith('magnet:')) return resolved;
    throw new Error(
      `Cardigann: download selector resolved to a non-magnet URL (${resolved}) - .torrent file downloading is not supported, only magnet: URIs.`
    );
  }

  if (download.infohash) {
    const html = await bodyFor(download.infohash.usebeforeresponse);
    const hash = extractFromHtml(html, download.infohash.hash);
    if (!hash) throw new Error(`Cardigann: download.infohash.hash did not match on ${opts.downloadUri}`);
    const title = extractFromHtml(html, download.infohash.title) || opts.itemTitle;
    return buildMagnetFromInfohash(hash, title);
  }

  throw new Error(`Cardigann: download block exhausted with no magnet resolved for ${opts.downloadUri}`);
}
