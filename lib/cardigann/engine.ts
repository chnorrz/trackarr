import { collectCategoryMappings } from './category-mapping.js';
import { applyFilter, andMatch, type FilterSpec } from './filters.js';
import { extractField, renderFilterArgs, type FieldSpec, type FieldsBlock } from './extract.js';
import { renderTemplate, type TemplateContext } from './template.js';
import { selectDomRows, selectDocumentRow, selectJsonRows } from './select.js';

// No network I/O anywhere in this file, deliberately - everything here is a
// pure function of (definition, an already-fetched response body, search
// context) so it's fully unit-testable without cfFetch/a browser. Wiring
// requestDelay/cookies/actual fetching and the definition->Provider adapter
// is phase 3 (NOTES.md's Cardigann section).

export interface SearchContext {
  keywords: string;
  /** Torznab category ids requested, already mapped to this tracker's own ids for .Categories - phase 3's job, engine.ts just consumes the result. */
  categories: string[];
  offset: number;
  limit: number;
  config: Record<string, string>;
  query?: Record<string, string>;
}

export interface CardigannItem {
  title: string;
  detailUrl: string;
  size: number;
  seeds: number;
  leechers: number;
  /** The raw Cardigann category name (e.g. "TV/Anime"), NOT yet mapped to a numeric Torznab id - that mapping needs the (phase 3) extended category vocabulary, out of scope here. */
  category: string;
  pubDate: Date;
  download?: string;
  magnet?: string;
  /** A bare infohash string (fields.infohash) - distinct from download.infohash's separate {hash,title} sub-selector mechanism, which is a download.ts/phase 3 concern, not read here. Phase 3 constructs magnet:?xt=urn:btih:<infohash>&dn=<title>&tr=... from this plus the item's own title. */
  infohash?: string;
  description?: string;
  poster?: string;
  imdbid?: string;
}

interface RowsBlock {
  selector: string;
  filters?: FilterSpec[];
  attribute?: string;
  count?: { selector: string };
}

interface ResponseBlock {
  type?: 'json' | 'xml';
}

interface SearchBlock {
  rows: RowsBlock;
  fields: FieldsBlock;
  response?: ResponseBlock;
  /** Applied to the raw response body before any row parsing - e.g. wrapping
   * a bare <tr> soup in <table></table>, or reshaping a JSON envelope with
   * jsonjoinarray. */
  preprocessingfilters?: FilterSpec[];
  /** Extracted once per response (not once per row) into .Vars.* - e.g. a
   * page-level csrf/session token that every row's download link needs. */
  vars?: FieldsBlock;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

// `category` fields match a mapping by tracker id (compared as a string so
// numeric YAML ids and string selector output line up); `categorydesc`
// fields match by desc case-insensitively - the schema's own documented
// alternative for sites that only expose a category name, not an id. Reads
// both of caps.categorymappings (array) and caps.categories (object) via
// category-mapping.ts, since a definition may use either shape.
function resolveCategoryName(definition: Record<string, unknown>, categoryRaw: string | undefined, categoryDescRaw: string | undefined): string {
  const mappings = collectCategoryMappings(definition);

  if (categoryRaw !== undefined && categoryRaw !== '') {
    const match = mappings.find((m) => m.trackerId === categoryRaw);
    if (match) return match.standardName;
  }
  if (categoryDescRaw !== undefined && categoryDescRaw !== '') {
    const match = mappings.find((m) => m.desc !== undefined && m.desc.toLowerCase() === categoryDescRaw.toLowerCase());
    if (match) return match.standardName;
  }
  return 'Other';
}

function parseSizeBytes(raw: string): number {
  // Cardigann's own size parsing accepts both thousands-comma and
  // thousands-dot forms (the wiki: "Sites using European numbering schemes
  // ... there is no need to remove commas or extra dots"). Strip thousands
  // separators before handing off to our existing parseSize, which expects
  // a plain "1234.5 MB" shape.
  const trimmed = raw.trim();
  // JSON APIs commonly report a plain byte count with no unit at all (e.g.
  // milkie.yml's own `size_bytes` selector name implies this) - HTML
  // scraping always has a unit suffix ("1.5 GB"). A bare number means bytes
  // directly, not a size string missing its unit.
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed));

  const cleaned = trimmed.replace(/(\d)[.,](?=\d{3}(?:\D|$))/g, '$1');
  const m = /([\d.]+)\s*(B|KB|MB|GB|TB)/i.exec(cleaned);
  if (!m) return 0;
  const num = parseFloat(m[1] as string);
  const unit = (m[2] as string).toUpperCase();
  const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(num * (mult[unit] ?? 1));
}

function parseDateOrNow(raw: string): Date {
  if (!raw) return new Date();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

// Unsliced: returns every item the response yields. runSearch() below is the
// normal single-response entry point (slices to searchCtx.offset/limit); a
// multi-path search (adapter.ts, phase 3) needs the raw list from each
// path's own response so it can concatenate before slicing once, not once
// per path.
export function runSearchAll(definition: Record<string, unknown>, body: string, searchCtx: SearchContext): CardigannItem[] {
  const search = asRecord(definition.search) as unknown as SearchBlock;
  const responseType = search.response?.type;

  // Bound once for the whole response, not read live per-reference - so a
  // rendered timestamp field and a hash computed from that same timestamp
  // (e.g. an HMAC) can't observe two different clock reads mid-request.
  const now = String(Math.floor(Date.now() / 1000));

  const topCtx: TemplateContext = {
    Keywords: searchCtx.keywords,
    Query: searchCtx.query ?? {},
    Categories: searchCtx.categories,
    Config: searchCtx.config,
    Result: {},
    Now: now
  };
  const preprocessed = (search.preprocessingfilters ?? []).reduce(
    (v, f) => applyFilter(f.name, renderFilterArgs(f.args, topCtx), v),
    body
  );

  // A definition can template its own rows.selector (e.g. 1337x.yml's
  // optional :has(...) clause driven off .Config.uploader) - rendered
  // against topCtx, same context every other pre-row-loop value uses.
  const rowsResult =
    responseType === 'json'
      ? selectJsonRows(preprocessed, search.rows)
      : {
          rows: selectDomRows(preprocessed, renderTemplate(search.rows.selector, topCtx), responseType === 'xml'),
          explicitNoResults: false
        };

  if (rowsResult.explicitNoResults) return [];

  // Document-scoped, extracted once regardless of row count - topCtx.Result
  // is reused as scratch space here (extractField writes to it) since
  // topCtx isn't consulted again after this point.
  const docVars: Record<string, string> = {};
  if (search.vars) {
    const docRow = selectDocumentRow(preprocessed, responseType);
    for (const [name, spec] of Object.entries(search.vars)) {
      docVars[name] = extractField(docRow, name, spec, topCtx);
    }
  }

  const items: CardigannItem[] = [];

  for (const row of rowsResult.rows) {
    if (search.rows.filters) {
      const text = row.rawText();
      const passesRowFilters = search.rows.filters.every((f) => {
        if (f.name === 'strdump') {
          console.error(`[cardigann] strdump(row): ${text}`);
          return true;
        }
        if (f.name === 'andmatch') {
          const maxLength = f.args === undefined ? undefined : Number(Array.isArray(f.args) ? f.args[0] : f.args);
          return andMatch(text, searchCtx.keywords, maxLength);
        }
        return true;
      });
      if (!passesRowFilters) continue;
    }

    const ctx: TemplateContext = {
      Keywords: searchCtx.keywords,
      Query: searchCtx.query ?? {},
      Categories: searchCtx.categories,
      Config: searchCtx.config,
      Result: {},
      Vars: docVars,
      Now: now
    };

    const fieldNames = Object.keys(search.fields);
    for (const name of fieldNames) {
      extractField(row, name, search.fields[name] as FieldSpec, ctx);
    }

    const r = ctx.Result;
    const category = resolveCategoryName(definition, r.category, r.categorydesc);

    const item: CardigannItem = {
      title: r.title ?? '',
      detailUrl: r.details ?? '',
      size: parseSizeBytes(r.size ?? ''),
      seeds: Number(r.seeders) || 0,
      leechers: Number(r.leechers) || 0,
      category,
      pubDate: parseDateOrNow(r.date ?? '')
    };

    if (r.download) item.download = r.download;
    if (r.magnet) item.magnet = r.magnet;
    if (r.infohash) item.infohash = r.infohash;
    if (r.description) item.description = r.description;
    if (r.poster) item.poster = r.poster;
    if (r.imdbid) item.imdbid = r.imdbid;

    items.push(item);
  }

  return items;
}

export function runSearch(definition: Record<string, unknown>, body: string, searchCtx: SearchContext): CardigannItem[] {
  const items = runSearchAll(definition, body, searchCtx);
  return items.slice(searchCtx.offset, searchCtx.offset + searchCtx.limit);
}
