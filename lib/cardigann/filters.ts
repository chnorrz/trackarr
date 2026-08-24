import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { formatRFC1123, parseWithFormat } from './date-format.js';
import { parseFuzzyTime, parseTimeAgo } from './relative-time.js';

// The 24 of 25 FilterBlock names implemented (jsonjoinarray excluded - see
// lib/cardigann/capability.ts). Semantics and every worked example below are
// transcribed from wiki.servarr.com/prowlarr/cardigann-yml-definition
// ("Filters" section) - each filter's test asserts its own wiki example,
// which is the closest thing to a spec this format has.
//
// sha256/concat below are NOT upstream Cardigann filters - they're a
// trackarr-only extension (lib/cardigann/schema-extensions.json adds them to
// FilterBlock's name enum), for building HMAC-signed download links like
// ext.to's. A definition using either validates only under the extended
// schema (load.ts's `portable: false`).
export type FilterArgs = string | number | string[] | undefined;

function toStringArg(args: FilterArgs): string {
  if (Array.isArray(args)) return args[0] ?? '';
  return args === undefined ? '' : String(args);
}

function toArgsArray(args: FilterArgs): string[] {
  if (Array.isArray(args)) return args;
  return args === undefined ? [] : [String(args)];
}

function querystring(value: string, args: FilterArgs): string {
  const key = toStringArg(args);
  const qIndex = value.indexOf('?');
  const qs = qIndex === -1 ? value : value.slice(qIndex + 1);
  return new URLSearchParams(qs).get(key) ?? '';
}

function trim(value: string, args: FilterArgs): string {
  if (args === undefined) return value.trim();
  const chars = toStringArg(args).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return value.replace(new RegExp(`^[${chars}]+|[${chars}]+$`, 'g'), '');
}

function regexp(value: string, args: FilterArgs): string {
  const pattern = toStringArg(args);
  const m = new RegExp(pattern).exec(value);
  if (!m) return '';
  return m[1] ?? m[0];
}

function replaceFilter(value: string, args: FilterArgs): string {
  const [pattern, replacement] = toArgsArray(args);
  return value.split(pattern ?? '').join(replacement ?? '');
}

function reReplace(value: string, args: FilterArgs): string {
  const [pattern, replacement] = toArgsArray(args);
  return value.replace(new RegExp(pattern ?? '', 'g'), replacement ?? '');
}

function split(value: string, args: FilterArgs): string {
  const [sep, indexStr] = toArgsArray(args);
  const parts = value.split(sep ?? '');
  return parts[Number(indexStr)] ?? '';
}

// Splits on any of , / . ) ( ; [ ] " | : - matching the wiki's own
// delimiter list verbatim. Restores validate's own underscore-for-space
// convention on output (the wiki: "to preserve a double word ... replace
// spaces with underscores - auto-restored in results").
function validate(value: string, args: FilterArgs): string {
  const validList = toStringArg(args).split(',').map((s) => s.trim()).filter(Boolean);
  const validLower = new Set(validList.map((s) => s.toLowerCase()));
  const tokens = value.split(/[,/.)(;[\]"|:]+/).map((s) => s.trim()).filter(Boolean);
  return tokens
    .filter((t) => validLower.has(t.toLowerCase()))
    .map((t) => t.toLowerCase().replace(/_/g, ' '))
    .join(', ');
}

function dateparse(value: string, args: FilterArgs): string {
  const date = parseWithFormat(value, toStringArg(args));
  return date ? formatRFC1123(date) : '';
}

function timeago(value: string): string {
  const date = parseTimeAgo(value);
  return date ? formatRFC1123(date) : '';
}

function fuzzytime(value: string): string {
  const date = parseFuzzyTime(value);
  return date ? formatRFC1123(date) : '';
}

function htmldecode(value: string): string {
  // cheerio's own HTML parser already decodes entities correctly (named,
  // numeric, hex) - reusing it avoids a second, likely-incomplete
  // hand-rolled entity table.
  return cheerio.load(`<x>${value}</x>`)('x').text();
}

function htmlencode(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function urldecode(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, ' '));
}

function urlencode(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

function validfilename(value: string): string {
  return value.replace(/[\\/:*?"<>|\s]/g, '');
}

function diacritics(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function hexdump(value: string): string {
  const hex = [...value].map((c) => `${c}(${c.charCodeAt(0).toString(16).toUpperCase()})`).join('');
  console.error(`[cardigann] hexdump: ${hex}`);
  return value;
}

function strdump(value: string, args: FilterArgs): string {
  const tag = args === undefined ? '' : `(${toStringArg(args)})`;
  console.error(`[cardigann] strdump${tag}: ${value}`);
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// No separator is inserted - callers pass any needed separators as their own
// literal args, e.g. {{ sha256 (concat .A "|" .B "|" .C) }}.
function concat(value: string, args: FilterArgs): string {
  return value + toArgsArray(args).join('');
}

type FilterFn = (value: string, args: FilterArgs) => string;

const FILTERS: Record<string, FilterFn> = {
  querystring,
  prepend: (value, args) => toStringArg(args) + value,
  append: (value, args) => value + toStringArg(args),
  tolower: (value) => value.toLowerCase(),
  toupper: (value) => value.toUpperCase(),
  replace: replaceFilter,
  split,
  trim,
  regexp,
  re_replace: reReplace,
  validate,
  dateparse,
  timeparse: dateparse,
  timeago,
  reltime: timeago,
  fuzzytime,
  htmldecode,
  htmlencode,
  urldecode,
  urlencode,
  validfilename,
  diacritics,
  hexdump,
  strdump,
  sha256,
  concat
};

export interface FilterSpec {
  name: string;
  args?: FilterArgs;
}

// Row filters (search.rows.filters) use a different, much smaller vocabulary
// than field filters - see capability.ts's SUPPORTED_ROW_FILTERS.
export function applyFilter(name: string, args: FilterArgs, value: string): string {
  const fn = FILTERS[name];
  if (!fn) throw new Error(`applyFilter: unsupported filter "${name}" - should have been caught by the capability gate`);
  return fn(value, args);
}

export function isKnownFilter(name: string): boolean {
  return name in FILTERS;
}

export function applyFilters(filters: FilterSpec[] | undefined, value: string): string {
  if (!filters) return value;
  let result = value;
  for (const f of filters) result = applyFilter(f.name, f.args, result);
  return result;
}

// andmatch/strdump - search.rows.filters, applied to a whole extracted row's
// text rather than a single field's value.
export function andMatch(rowText: string, keywords: string, maxLength?: number): boolean {
  const words = keywords.trim().split(/\s+/).filter(Boolean);
  const haystack = (maxLength ? rowText.slice(0, maxLength) : rowText).toLowerCase();
  return words.every((w) => haystack.includes(w.toLowerCase()));
}
