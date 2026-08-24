import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

// Shape mirrors schema.json's SelectorBlock/RowsBlock/FieldsBlock fields
// that this engine actually implements. `text` and `default` are template
// strings verbatim - select.ts never renders templates (it has no template
// context); engine.ts renders them, since a selector-*extracted* value must
// NOT be template-rendered (it's real scraped content that could coincide
// with literal "{{" text) while an author-written `text:`/`default:` value
// always must be.
export interface SelectorSpec {
  selector?: string;
  attribute?: string;
  text?: string;
  optional?: boolean;
  default?: string;
  remove?: string;
  case?: Record<string, string>;
}

export interface ExtractResult {
  raw: string;
  matched: boolean;
}

export interface Row {
  kind: 'html' | 'xml' | 'json';
  extract(spec: SelectorSpec): ExtractResult;
  /** Whole-row text, used by search.rows.filters (andmatch/strdump) - applied to the row as a unit, before field extraction. */
  rawText(): string;
}

// ---------------------------------------------------------------------------
// HTML / XML backend (cheerio). :has()/:not()/:contains() are native cheerio
// (css-select) pseudo-selectors - no custom parsing needed here, unlike JSON.
// ---------------------------------------------------------------------------

class DomRow implements Row {
  kind: 'html' | 'xml';

  constructor(
    private $: cheerio.CheerioAPI,
    private el: AnyNode,
    kind: 'html' | 'xml'
  ) {
    this.kind = kind;
  }

  extract(spec: SelectorSpec): ExtractResult {
    if (spec.case) return this.extractCase(spec.case);
    if (spec.text !== undefined) return { raw: spec.text, matched: true };

    // A lasting mutation, not a per-field clone - matches the wiki's own
    // advice to put remove-using fields at the end of the list ("any
    // removed elements ... won't be available to following fields").
    if (spec.remove) this.$(this.el).find(spec.remove).remove();

    if (!spec.selector) return { raw: '', matched: false };

    const found = this.$(this.el).find(spec.selector).first();
    if (found.length === 0) return { raw: '', matched: false };

    const raw = spec.attribute !== undefined ? (found.attr(spec.attribute) ?? '') : found.text().trim();
    return { raw, matched: true };
  }

  rawText(): string {
    return this.$(this.el).text();
  }

  private extractCase(caseMap: Record<string, string>): ExtractResult {
    // HTML/XML case: each key (other than the "*" wildcard) IS a selector,
    // tested against this row; first match in declaration order wins. Object
    // key order is insertion order for string keys in JS, matching the
    // wiki's "processing ends after the first case selector matches".
    for (const [selector, value] of Object.entries(caseMap)) {
      if (selector === '*') continue;
      if (this.$(this.el).is(selector) || this.$(this.el).find(selector).length > 0) {
        return { raw: value, matched: true };
      }
    }
    return '*' in caseMap ? { raw: caseMap['*'] as string, matched: true } : { raw: '', matched: false };
  }
}

export function selectDomRows(body: string, rowsSelector: string, xmlMode: boolean): Row[] {
  const $ = cheerio.load(body, { xmlMode });
  const kind = xmlMode ? 'xml' : 'html';
  return $(rowsSelector)
    .toArray()
    .map((el) => new DomRow($, el, kind));
}

// A whole-document "row" - used for search.vars, which are extracted once
// per response (not once per result row) via the same SelectorSpec/Row
// mechanism the per-row fields use. HTML/XML: the document root, so a
// selector reaches anywhere in the page (e.g. a page-level csrf token
// outside the results table). JSON: the parsed root value, inner===outer
// since there's no outer/inner distinction without a rows.attribute.
export function selectDocumentRow(body: string, responseType: 'json' | 'xml' | undefined): Row {
  if (responseType === 'json') {
    const root: unknown = JSON.parse(body);
    return new JsonRow(root, root);
  }
  const xmlMode = responseType === 'xml';
  const $ = cheerio.load(body, { xmlMode });
  return new DomRow($, $.root()[0] as AnyNode, xmlMode ? 'xml' : 'html');
}

// ---------------------------------------------------------------------------
// JSON backend. Cardigann's JSON selectors are dot-paths (with a leading "$"
// for the document root) whose segments can carry :has()/:not()/:contains()
// clauses, e.g. `data:has(attributes.size):not(attributes.uploader:contains(X))`
// (wiki's own "Search Row Selectors" example) or TPB's own real
// `$:has(username:contains({{ .Config.uploader }}))`. There is no library
// for this - it's a small, bounded language, parsed and evaluated here.
//
// Deliberately NOT implemented (no evidence any addressable definition needs
// it): wildcards, array slicing, recursive descent. `[N]` numeric indexing
// is supported only because thepiratebay.yml's own `count.selector: $[0].id`
// needs it.
// ---------------------------------------------------------------------------

type JsonClause = { type: 'has' | 'not'; path: JsonSegment[] } | { type: 'contains'; text: string };

interface JsonSegment {
  name: string; // '' | '$' | a property key
  index?: number;
  clauses: JsonClause[];
}

// Splits on '.' at paren-depth 0 only - a bare split would incorrectly break
// "attributes.size" apart when it appears *inside* a :has(...) clause.
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === '.' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

const CLAUSE_START = /^:(has|not|contains)\(/;

function parseSegment(raw: string): JsonSegment {
  let i = 0;
  let namePart = '';
  while (i < raw.length) {
    if (raw[i] === ':' && CLAUSE_START.test(raw.slice(i))) break;
    namePart += raw[i];
    i++;
  }

  const indexMatch = /^(.*?)\[(\d+)\]$/.exec(namePart);
  const name = indexMatch ? (indexMatch[1] as string) : namePart;
  const index = indexMatch ? Number(indexMatch[2]) : undefined;

  const clauses: JsonClause[] = [];
  while (i < raw.length) {
    const m = CLAUSE_START.exec(raw.slice(i));
    if (!m) break;
    const kind = m[1] as 'has' | 'not' | 'contains';
    i += m[0].length;

    let depth = 1;
    let j = i;
    while (j < raw.length && depth > 0) {
      if (raw[j] === '(') depth++;
      if (raw[j] === ')') depth--;
      j++;
    }
    const inner = raw.slice(i, j - 1);
    i = j;

    clauses.push(kind === 'contains' ? { type: 'contains', text: inner } : { type: kind, path: parseJsonPath(inner) });
  }

  return { name, index, clauses };
}

function parseJsonPath(raw: string): JsonSegment[] {
  return splitTopLevel(raw).map(parseSegment);
}

function isTruthyJson(value: unknown): boolean {
  if (value === undefined || value === null || value === '' || value === false) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function evalClause(clause: JsonClause, item: unknown, root: unknown): boolean {
  if (clause.type === 'contains') return typeof item === 'string' && item.includes(clause.text);
  const matched = isTruthyJson(navigateJson(item, clause.path, root));
  return clause.type === 'has' ? matched : !matched;
}

function navigateJson(value: unknown, segments: JsonSegment[], root: unknown): unknown {
  let current = value;
  for (const seg of segments) {
    if (seg.name === '$') {
      current = root;
    } else if (seg.name !== '') {
      current = current !== null && typeof current === 'object' ? (current as Record<string, unknown>)[seg.name] : undefined;
    }
    if (seg.index !== undefined) {
      current = Array.isArray(current) ? current[seg.index] : undefined;
    }
    if (seg.clauses.length > 0) {
      const passes = (item: unknown): boolean => seg.clauses.every((c) => evalClause(c, item, root));
      current = Array.isArray(current) ? current.filter(passes) : passes(current) ? current : undefined;
    }
  }
  return current;
}

// Resolves a full path string (e.g. "data.movies", "$[0].id",
// "$:has(username:contains(bob))") against a JSON document.
export function resolveJsonPath(root: unknown, path: string): unknown {
  return navigateJson(root, parseJsonPath(path), root);
}

// A JSON "row" is two views of the same underlying data: `outer` (the row
// object itself, e.g. a movie) and `inner` (the object field selectors
// actually read from - the same as outer unless rows.attribute names a
// nested list, e.g. a movie's `torrents`). A field selector prefixed with
// ".." (the wiki's own documented syntax) reaches back to `outer` instead of
// `inner` - the one Cardigann-specific meaning "leading .." has here, not a
// general path feature, so it's handled before the generic path parser runs.
class JsonRow implements Row {
  kind = 'json' as const;

  constructor(
    private inner: unknown,
    private outer: unknown
  ) {}

  extract(spec: SelectorSpec): ExtractResult {
    const plain = spec.text !== undefined ? spec.text : spec.selector ? this.resolveToString(spec.selector) : undefined;

    if (spec.case) {
      // JSON case: unlike HTML, keys are compared by VALUE EQUALITY against
      // whatever this same field's own selector/text already resolved
      // (thepiratebay.yml's own
      // `downloadvolumefactor: { selector: freeleech, case: {0: 1, 1: 0} }`),
      // not treated as selectors themselves.
      const key = plain ?? '';
      if (key in spec.case) return { raw: spec.case[key] as string, matched: true };
      return '*' in spec.case ? { raw: spec.case['*'] as string, matched: true } : { raw: '', matched: false };
    }

    if (plain === undefined) return { raw: '', matched: false };
    return { raw: plain, matched: true };
  }

  private resolve(path: string): unknown {
    const usesOuter = path.startsWith('..');
    const target = usesOuter ? this.outer : this.inner;
    const cleanPath = usesOuter ? path.slice(2) : path;
    return cleanPath === '' ? target : navigateJson(target, parseJsonPath(cleanPath), target);
  }

  private resolveToString(path: string): string | undefined {
    const value = this.resolve(path);
    if (value === undefined) return undefined;
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  rawText(): string {
    return JSON.stringify(this.inner);
  }
}

export interface JsonRowsBlock {
  selector: string;
  attribute?: string;
  count?: { selector: string };
}

export interface JsonSelectResult {
  rows: Row[];
  /** true when `count` resolved to something falsy - an explicit "no results", distinct from a selector simply matching nothing. */
  explicitNoResults: boolean;
}

export function selectJsonRows(body: string, rowsBlock: JsonRowsBlock): JsonSelectResult {
  const root: unknown = JSON.parse(body);

  if (rowsBlock.count) {
    const countValue = resolveJsonPath(root, rowsBlock.count.selector);
    if (!isTruthyJson(countValue)) return { rows: [], explicitNoResults: true };
  }

  const selected = resolveJsonPath(root, rowsBlock.selector);
  const outerRows = Array.isArray(selected) ? selected : selected === undefined ? [] : [selected];

  const rows: Row[] = [];
  for (const outer of outerRows) {
    if (!rowsBlock.attribute) {
      rows.push(new JsonRow(outer, outer));
      continue;
    }
    const inner = outer !== null && typeof outer === 'object' ? (outer as Record<string, unknown>)[rowsBlock.attribute] : undefined;
    // Missing attribute on a row: skipped, not fatal - the overall result
    // degrades to fewer items rather than throwing. This makes
    // missingAttributeEqualsNoResults (schema.json) a no-op in this engine:
    // an empty result is already how a wholly-missing attribute behaves.
    if (inner === undefined) continue;
    const innerList = Array.isArray(inner) ? inner : [inner];
    for (const item of innerList) rows.push(new JsonRow(item, outer));
  }

  return { rows, explicitNoResults: false };
}
