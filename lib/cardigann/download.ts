import * as cheerio from 'cheerio';
import { extractField, type FieldsBlock } from './extract.js';
import { applyFilters, type FilterSpec } from './filters.js';
import { buildQueryString, type InputsBlock } from './inputs.js';
import { resolveJsonPath, selectDocumentRow } from './select.js';
import { renderTemplate, type DownloadUri, type TemplateContext } from './template.js';
import type { ResolvedDownload } from '../types.js';

// Resolves the wiki's "Download" section: when a listing doesn't already
// carry a usable magnet/download link, this walks the documented
// before -> selectors -> infohash chain to find one - a magnet: URI, or a
// real .torrent file's bytes (fetched here, not just handed back as a URL -
// see NOTES.md). Live-tested against ext.to, 1337x and EZTV's real
// definitions (NOTES.md).

interface SimpleSelectorSpec {
  selector?: string;
  attribute?: string;
  usebeforeresponse?: boolean;
  filters?: FilterSpec[];
}

interface BeforeBlock {
  path?: string;
  pathselector?: SimpleSelectorSpec;
  method?: string;
  inputs?: InputsBlock;
  queryseparator?: string;
  /** Extracted once from the item's own page (opts.downloadUri, fetched
   * fresh on this call - not carried over from search.vars, which stays
   * scoped to the search response) into .Vars.*, for use inside this same
   * before block's path/inputs templates - e.g. a page-level csrf token
   * needed to sign a POST body. Trackarr-only; not a wiki-documented field. */
  vars?: FieldsBlock;
  /** Forwarded to inputs.ts's buildQueryString - by default an input whose
   * rendered value is empty is dropped from the request entirely; some APIs
   * require the key present-but-empty instead. Trackarr-only. */
  allowEmptyInputs?: boolean;
}

interface InfoHashBlock {
  hash: SimpleSelectorSpec;
  title: SimpleSelectorSpec;
  usebeforeresponse?: boolean;
}

interface DownloadBlockDef {
  method?: string;
  before?: BeforeBlock;
  selectors?: SimpleSelectorSpec[];
  infohash?: InfoHashBlock;
  headers?: Record<string, string[]>;
}

// Structurally matches lib/browser.ts's CfResponse (cfFetch's real return
// type) - so cfFetch itself is directly assignable as a Fetcher, one
// injected dependency for the whole module instead of a text/binary split.
// Most call sites below only ever read .text(); the one download.selectors[]
// site that resolves to a raw file (not magnet:) reads .buffer() and
// .filename instead - see there.
export interface Fetcher {
  (url: string, opts?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    text(): Promise<string>;
    buffer(): Promise<Buffer>;
    filename?: string;
  }>;
}

// HTTP header values (Content-Disposition's filename) and filesystems both
// reject/mangle quotes, control characters and path separators - the same
// restriction magnet's own &dn= sidesteps via percent-encoding, but a
// filename has to actually be a plausible filename. name is typically the
// real Content-Disposition filename now (BinaryFetcher's own
// suggestedFilename()), not the item title - already has a sane extension,
// so this doesn't blindly append .torrent on top of one.
function sanitizeFilename(name: string): string {
  const cleaned = [...name]
    .filter((c) => c.charCodeAt(0) > 0x1f && !'"\\/'.includes(c))
    .join('')
    .trim();
  const base = cleaned || 'download';
  return base.toLowerCase().endsWith('.torrent') ? base : `${base}.torrent`;
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

// DownloadBlockDef.headers is Record<string,string[]> (Cardigann's own
// multi-value header shape, e.g. repeated Cookie values); Fetcher's opts
// take a plain Record<string,string>, so multiple values for one name are
// joined per HTTP's standard combination rule.
function flattenHeaders(headers: Record<string, string[]> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const flat: Record<string, string> = {};
  for (const [key, values] of Object.entries(headers)) flat[key] = values.join(', ');
  return flat;
}

// A "$"-prefixed selector means the download response is JSON, same
// convention search.fields uses (select.ts's resolveJsonPath) - the download
// block has no separate response.type declaration, so this is detected from
// the selector itself rather than any surrounding config. The selector
// itself is template-rendered first (1337x.yml's download.selectors
// reference .Config.downloadlink) - selectors elsewhere in this file are
// scraped content, never templates, so this is the one place that matters.
function extractFromBody(body: string, spec: SimpleSelectorSpec, ctx: TemplateContext): string {
  if (!spec.selector) return '';
  const selector = renderTemplate(spec.selector, ctx);
  if (!selector) return '';

  if (selector.startsWith('$')) {
    const root: unknown = JSON.parse(body);
    const value = resolveJsonPath(root, selector);
    if (value === undefined) return '';
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    return applyFilters(spec.filters, raw);
  }

  const $ = cheerio.load(body);
  const found = $(selector).first();
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
  /** The same .Config a search() call for this indexer would use (settings
   * defaults + the operator's own config: overrides + sitelink) - a
   * definition's download block can reference it too (1337x.yml's
   * download.selectors use .Config.downloadlink). Defaults to {} for
   * callers/tests that don't need it. */
  config?: Record<string, string>;
  fetch: Fetcher;
}

export async function resolveCardigannDownload(opts: ResolveOptions): Promise<ResolvedDownload> {
  if (opts.downloadUri.startsWith('magnet:')) return { kind: 'magnet', magnet: opts.downloadUri };

  const download = (opts.definition.download as DownloadBlockDef | undefined) ?? undefined;
  const downloadUriCtx = buildDownloadUri(opts.downloadUri);
  // Bound once per call, not carried over from any earlier search response -
  // each resolveCardigannDownload call is its own fresh grab.
  const now = String(Math.floor(Date.now() / 1000));
  const ctx: TemplateContext = {
    Keywords: '',
    Query: {},
    Categories: [],
    Config: opts.config ?? {},
    Result: { title: opts.itemTitle },
    DownloadUri: downloadUriCtx,
    Now: now
  };

  if (!download) {
    // No download block declared: the item's own captured link is assumed
    // to be a real page containing a magnet, on the item's detail page.
    const html = await (await opts.fetch(opts.downloadUri)).text();
    const magnet = extractFromBody(html, { selector: 'a[href^="magnet:"]', attribute: 'href' }, ctx);
    if (magnet) return { kind: 'magnet', magnet };
    throw new Error(`Cardigann: no download block and no magnet link found on ${opts.downloadUri}`);
  }

  const headers = flattenHeaders(download.headers);

  let beforeResponseBody: string | undefined;

  if (download.before) {
    let beforePath = download.before.path;

    // A source-page fetch happens if pathselector needs it (the wiki's own
    // "thankyou link" example: the next path is scraped off the item's own
    // page) and/or if vars are declared (a page-level token needed inside
    // this same before block's path/inputs templates) - one fetch covers
    // both needs when a definition uses them together.
    if ((!beforePath && download.before.pathselector) || download.before.vars) {
      const sourceHtml = await (await opts.fetch(opts.downloadUri, headers ? { headers } : undefined)).text();
      if (!beforePath && download.before.pathselector) {
        beforePath = extractFromBody(sourceHtml, download.before.pathselector, ctx);
      }
      if (download.before.vars) {
        const docRow = selectDocumentRow(sourceHtml, undefined);
        const docVars: Record<string, string> = {};
        for (const [name, spec] of Object.entries(download.before.vars)) {
          docVars[name] = extractField(docRow, name, spec, ctx);
        }
        ctx.Vars = docVars;
      }
    }
    if (!beforePath) {
      throw new Error(`Cardigann: download.before resolved to no path for ${opts.downloadUri}`);
    }

    const method = (download.before.method ?? 'get').toUpperCase();
    const renderedPath = renderTemplate(beforePath, ctx);
    const qs = buildQueryString(download.before.inputs, ctx, {
      queryseparator: download.before.queryseparator,
      allowEmptyInputs: download.before.allowEmptyInputs
    });
    const beforeUrl = new URL(renderedPath, opts.downloadUri);

    if (method === 'GET') {
      if (qs) beforeUrl.search = beforeUrl.search ? `${beforeUrl.search}&${qs}` : qs;
      beforeResponseBody = await (await opts.fetch(beforeUrl.toString(), headers ? { headers } : undefined)).text();
    } else {
      beforeResponseBody = await (
        await opts.fetch(beforeUrl.toString(), {
          method,
          headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: qs
        })
      ).text();
    }
  }

  let defaultResponseBody: string | undefined;
  const bodyFor = async (usebeforeresponse: boolean | undefined): Promise<string> => {
    if (usebeforeresponse) {
      if (beforeResponseBody === undefined) throw new Error('Cardigann: usebeforeresponse:true but no download.before block ran');
      return beforeResponseBody;
    }
    if (defaultResponseBody === undefined) defaultResponseBody = await (await opts.fetch(opts.downloadUri, headers ? { headers } : undefined)).text();
    return defaultResponseBody;
  };

  // A real definition's selectors[] is an ordered fallback list by design -
  // 1337x.yml's own info_download setting text says as much ("we suggest
  // using the magnet link as a fallback [to iTorrents]"). A selector that
  // *matches* but points at a link that's actually dead (a stale mirror, a
  // site that retired a CDN) must fall through to the next selector, not
  // abort the whole resolution - only an empty (non-)match did that
  // before. The last such failure is kept so a real reason surfaces if
  // every selector in the list fails.
  let lastFetchError: Error | undefined;

  for (const selector of download.selectors ?? []) {
    const html = await bodyFor(selector.usebeforeresponse);
    const resolved = extractFromBody(html, selector, ctx);
    if (!resolved) continue;
    if (resolved.startsWith('magnet:')) return { kind: 'magnet', magnet: resolved };

    // Not a magnet: the wiki documents download.selectors[] as resolving to
    // either one - fetch the .torrent file's actual bytes through the same
    // session (headers included, e.g. auth cookies the link needs) rather
    // than handing the client a URL they can't themselves get past
    // Cloudflare with. resolved can be relative (a bare selector attribute,
    // same as any other extracted href) - resolved against downloadUri,
    // same as before.path already does elsewhere in this function.
    const absoluteUrl = new URL(resolved, opts.downloadUri).toString();
    try {
      const res = await opts.fetch(absoluteUrl, headers ? { headers } : undefined);
      const data = await res.buffer();
      if (data[0] !== 0x64) {
        // Every valid .torrent file is a bencoded dictionary, which always
        // starts with an ASCII 'd' - catches "actually got an HTML error
        // page" here, with a clear reason, instead of handing a client
        // garbage bytes it'll fail to parse with no explanation.
        throw new Error(`Cardigann: download selector resolved to ${absoluteUrl}, but the fetched content isn't a valid .torrent file.`);
      }
      // res.filename is the real Content-Disposition name (cfFetch's own
      // downloadFile()/Content-Disposition parse - see lib/browser.ts) when
      // the fetcher has one - falls back to the item's own title only if
      // that's somehow empty.
      return { kind: 'torrent', data, filename: sanitizeFilename(res.filename || opts.itemTitle) };
    } catch (err) {
      lastFetchError = err instanceof Error ? err : new Error(String(err));
      console.error(`[cardigann] download selector ${absoluteUrl} failed, trying the next one: ${lastFetchError.message}`);
    }
  }

  if (lastFetchError) throw lastFetchError;

  if (download.infohash) {
    const html = await bodyFor(download.infohash.usebeforeresponse);
    const hash = extractFromBody(html, download.infohash.hash, ctx);
    if (!hash) throw new Error(`Cardigann: download.infohash.hash did not match on ${opts.downloadUri}`);
    const title = extractFromBody(html, download.infohash.title, ctx) || opts.itemTitle;
    return { kind: 'magnet', magnet: buildMagnetFromInfohash(hash, title) };
  }

  throw new Error(`Cardigann: download block exhausted with no magnet resolved for ${opts.downloadUri}`);
}
