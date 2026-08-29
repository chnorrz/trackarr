// Schema-valid does not mean runnable: the vendored schema accepts private
// trackers, JSON/XML settings UIs, and filters we don't implement. This walks
// a validated definition and names every feature our engine cannot execute,
// so a bad definition is rejected loudly (see NOTES.md) rather than silently
// mis-parsed. See lib/cardigann/schema.json's FilterBlock/RowFilterBlock
// `name` enums for the full upstream filter vocabulary this is checked against.
const SUPPORTED_FIELD_FILTERS = new Set([
  'querystring', 'prepend', 'append', 'tolower', 'toupper', 'replace', 'split',
  'trim', 'regexp', 're_replace', 'validate', 'dateparse', 'timeparse',
  'timeago', 'reltime', 'fuzzytime', 'htmldecode', 'htmlencode', 'urldecode',
  'urlencode', 'validfilename', 'diacritics', 'hexdump', 'strdump',
  'jsonjoinarray', 'sha256', 'concat'
]);

const SUPPORTED_ROW_FILTERS = new Set(['andmatch', 'strdump']);

interface FilterLike {
  name?: unknown;
}

function isFilterArray(value: unknown): value is FilterLike[] {
  return Array.isArray(value) && value.every((v) => v !== null && typeof v === 'object' && 'name' in (v as object));
}

function collectFilterReasons(node: unknown, path: string, reasons: string[]): void {
  if (node === null || typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;

    if (key === 'filters' && isFilterArray(value)) {
      // search.rows.filters uses RowFilterBlock's (much smaller) enum;
      // every other `filters` array uses FilterBlock's.
      const isRowFilters = here === 'search.rows.filters';
      const allowed = isRowFilters ? SUPPORTED_ROW_FILTERS : SUPPORTED_FIELD_FILTERS;
      for (const f of value) {
        if (typeof f.name === 'string' && !allowed.has(f.name)) {
          reasons.push(`unsupported filter: ${f.name} (at ${here})`);
        }
      }
      continue;
    }

    if ((key === 'keywordsfilters' || key === 'preprocessingfilters') && isFilterArray(value)) {
      for (const f of value) {
        if (typeof f.name === 'string' && !SUPPORTED_FIELD_FILTERS.has(f.name)) {
          reasons.push(`unsupported filter: ${f.name} (at ${here})`);
        }
      }
      continue;
    }

    collectFilterReasons(value, here, reasons);
  }
}

export function checkCapability(definition: Record<string, unknown>): string[] {
  const reasons: string[] = [];

  if (definition.type !== 'public') {
    reasons.push(`type: ${String(definition.type)} (only public is supported)`);
  }

  if (definition.login !== undefined) {
    const login = definition.login as Record<string, unknown> | undefined;
    reasons.push(`login.method: ${String(login?.method)} (login/private-tracker flows are not supported)`);
  }

  const settings = definition.settings;

  if (Array.isArray(settings)) {
    for (const s of settings as Record<string, unknown>[]) {
      if (s.type === 'multi-select') {
        reasons.push(`settings.${String(s.name)}.type: multi-select (unsupported even by Prowlarr itself)`);
      }
    }
  }

  const search = definition.search as Record<string, unknown> | undefined;
  const rows = search?.rows as Record<string, unknown> | undefined;

  if (rows?.dateheaders !== undefined) {
    reasons.push('search.rows.dateheaders (sibling date-row parsing is not supported)');
  }

  if (rows?.after !== undefined) {
    reasons.push('search.rows.after (multi-row merging is not supported)');
  }

  collectFilterReasons(definition, '', reasons);

  return reasons;
}
