import { applyFilter, type FilterArgs, type FilterSpec } from './filters.js';
import { renderTemplate, type TemplateContext } from './template.js';
import type { Row, SelectorSpec } from './select.js';

// Shared by engine.ts (search.fields, search.vars) and download.ts
// (download.before.vars) - both are "run a selector spec against a Row,
// apply its filters, render the result into the template context" with the
// exact same semantics, so there's one implementation of that instead of
// two that could drift.

export type FieldSpec = SelectorSpec & { filters?: FilterSpec[] };
export type FieldsBlock = Record<string, FieldSpec>;

// text:/default: values are author-written templates and must be rendered;
// selector/attribute/case-extracted values are real scraped content and
// must NOT be (a title could coincidentally contain literal "{{").
export function renderFilterArgs(args: FilterArgs, ctx: TemplateContext): FilterArgs {
  if (args === undefined) return undefined;
  if (Array.isArray(args)) return args.map((a) => renderTemplate(a, ctx));
  return renderTemplate(String(args), ctx);
}

export function extractField(row: Row, name: string, spec: FieldSpec, ctx: TemplateContext): string {
  const result = row.extract(spec);

  let value: string;
  if (!result.matched) {
    value = spec.optional && spec.default !== undefined ? renderTemplate(spec.default, ctx) : '';
  } else if (spec.text !== undefined) {
    // A case match also flows through here when spec.case was used and
    // matched (select.ts returns matched:true with the case's own literal
    // value as `raw`) - case values are NOT templates and must not be
    // re-rendered, so this branch is guarded to text: specifically, not
    // "matched && has no selector".
    value = spec.case ? result.raw : renderTemplate(spec.text, ctx);
  } else if (spec.case) {
    value = result.raw; // case's resolved literal - not a template
  } else {
    value = result.raw; // scraped content - not a template
  }

  // "Processing ends after the first case selector matches" (wiki) - a
  // case-resolved value skips the filter chain entirely.
  if (spec.case && result.matched) {
    ctx.Result[name] = value;
    return value;
  }

  const filtered = (spec.filters ?? []).reduce(
    (v, f) => applyFilter(f.name, renderFilterArgs(f.args, ctx), v),
    value
  );

  ctx.Result[name] = filtered;
  return filtered;
}
