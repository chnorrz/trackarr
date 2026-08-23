import { renderTemplate, type TemplateContext } from './template.js';

// Shared by paths.ts (search.paths[].inputs) and download.ts (download.before.inputs) -
// both are "a map of key -> templated value, joined into a querystring or form
// body" with the same two documented special cases:
//   - the "$raw" key is rendered as a template like any other value, but its
//     result is appended to the query string verbatim - not key=value
//     wrapped, not URL-encoded (wiki: "the result will be included in the
//     HTTP arguments list without further escaping (only variables are
//     escaped)"). Its value is expected to already contain literal
//     "key=val&..." text interleaved with {{ }} actions, e.g.
//     `{{ range .Categories }}category[]={{.}}&{{end}}`.
//   - an input whose rendered value is empty is dropped unless
//     allowEmptyInputs is true (wiki: "If a key resolves to a value that is
//     empty then Cardigann will not use that key/value pair").
export type InputsBlock = Record<string, string | number | boolean>;

export function renderInputValue(value: string | number | boolean, ctx: TemplateContext): string {
  return typeof value === 'string' ? renderTemplate(value, ctx) : String(value);
}

export function buildQueryString(
  inputs: InputsBlock | undefined,
  ctx: TemplateContext,
  opts: { queryseparator?: string; allowEmptyInputs?: boolean } = {}
): string {
  if (!inputs) return '';
  const sep = opts.queryseparator ?? '&';
  const parts: string[] = [];

  for (const [key, rawValue] of Object.entries(inputs)) {
    if (key === '$raw') {
      const rendered = renderInputValue(rawValue, ctx);
      if (rendered) parts.push(rendered);
      continue;
    }

    const value = renderInputValue(rawValue, ctx);
    if (value === '' && !opts.allowEmptyInputs) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }

  return parts.join(sep);
}
