import { buildQueryString, type InputsBlock } from './inputs.js';
import { renderTemplate, type TemplateContext } from './template.js';

// Builds the actual HTTP request(s) for a search from search.path/paths[],
// per wiki.servarr.com/prowlarr/cardigann-yml-definition's "Search HTML"
// section. One definition search can fan out into several real requests
// (e.g. kickasstorrents-to.yml's own two paths, page 1 and page 2, both
// unconditional) - callers fetch+parse each and concatenate before slicing
// to the caller's offset/limit (see engine.ts's runSearchAll).

export interface SearchPathBlockDef {
  path: string;
  method?: string;
  categories?: (number | string)[];
  inputs?: InputsBlock;
  inheritinputs?: boolean;
  queryseparator?: string;
}

export interface SearchBlockForPaths {
  path?: string;
  paths?: SearchPathBlockDef[];
  inputs?: InputsBlock;
  allowEmptyInputs?: boolean;
  headers?: Record<string, string[]>;
}

export interface PathRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

// "the path will be only used if at least one category from the list is
// included in the search categories list. A '!' as first entry negates the
// matching logic" (wiki, verbatim). requestedCategories is ctx.Categories -
// already-mapped tracker-native ids, not raw Torznab ones.
function pathAllowedForCategories(categories: (number | string)[] | undefined, requestedCategories: string[]): boolean {
  if (!categories || categories.length === 0) return true;
  const negate = categories[0] === '!';
  const ids = (negate ? categories.slice(1) : categories).map(String);
  const matches = ids.some((id) => requestedCategories.includes(id));
  return negate ? !matches : matches;
}

function buildOneRequest(
  pathDef: SearchPathBlockDef,
  search: SearchBlockForPaths,
  baseUrl: string,
  ctx: TemplateContext
): PathRequest {
  const method = (pathDef.method ?? 'get').toUpperCase();

  // inheritinputs defaults to true (merge search-level inputs as a base,
  // path inputs add/override); false means the path's own inputs stand
  // alone, entirely replacing the search-level list.
  const effectiveInputs: InputsBlock =
    pathDef.inheritinputs === false ? (pathDef.inputs ?? {}) : { ...(search.inputs ?? {}), ...(pathDef.inputs ?? {}) };

  const qs = buildQueryString(effectiveInputs, ctx, {
    queryseparator: pathDef.queryseparator,
    allowEmptyInputs: search.allowEmptyInputs
  });

  const renderedPath = renderTemplate(pathDef.path, ctx);
  const url = new URL(renderedPath, baseUrl);

  const headers: Record<string, string> = {};
  for (const [key, values] of Object.entries(search.headers ?? {})) {
    headers[key] = values.map((v) => renderTemplate(v, ctx)).join(', ');
  }

  if (method === 'GET') {
    if (qs) url.search = url.search ? `${url.search}&${qs}` : qs;
    return { url: url.toString(), method, headers: Object.keys(headers).length ? headers : undefined };
  }

  return {
    url: url.toString(),
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: qs
  };
}

export function buildPathRequests(search: SearchBlockForPaths, baseUrl: string, ctx: TemplateContext): PathRequest[] {
  const pathDefs: SearchPathBlockDef[] = search.paths ?? (search.path ? [{ path: search.path }] : []);

  return pathDefs
    .filter((p) => pathAllowedForCategories(p.categories, ctx.Categories))
    .map((p) => buildOneRequest(p, search, baseUrl, ctx));
}
