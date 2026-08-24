import { applyFilter, isKnownFilter, type FilterArgs } from './filters.js';

// A hand-written subset of Go's text/template, matching exactly what
// wiki.servarr.com/prowlarr/cardigann-yml-definition's "Template Engine"
// section documents: {{ if X }}...{{ else }}...{{ end }}, {{ if or/and (X)
// (Y) }}, {{ if eq/ne X Y }}, {{ join .Var "," }}, {{ range .Var }}...{{end}},
// {{ range $i, $e := .Var }}...{{end}}, plain {{ .Variable }} substitution,
// and any filter name callable inline (e.g. {{ re_replace .Keywords "x" "y" }}).
// Everything in this model is a string - Go template's "empty" truthiness
// (the zero value for the underlying type) collapses to "empty string" here,
// since every value this engine ever produces is a string.

export interface DownloadUri {
  AbsoluteUri: string;
  AbsolutePath: string;
  Scheme: string;
  Host: string;
  Port: string;
  PathAndQuery: string;
  Query: Record<string, string>;
}

export interface TemplateContext {
  Keywords: string;
  Query: Record<string, string>;
  Categories: string[];
  Config: Record<string, string>;
  Result: Record<string, string>;
  DownloadUri?: DownloadUri;
  /** search.vars, extracted once per response (not once per row) - see engine.ts. Deliberately does not flow into download.ts's context (stays scoped to the search response, per design). */
  Vars?: Record<string, string>;
  /** Unix seconds, bound once by the caller (engine.ts) for a whole
   * response - NOT computed live per-reference like .Today.Year, so a
   * body's timestamp and a hash of that timestamp can't drift apart mid-request. */
  Now?: string;
}

interface EvalContext extends TemplateContext {
  dot?: string;
  vars?: Record<string, string>;
}

// ---- tokenizer ----------------------------------------------------------

type Token =
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' }
  | { type: 'assign' } // :=
  | { type: 'string'; value: string }
  | { type: 'word'; value: string };

function tokenize(raw: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ type: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ type: 'rparen' });
      i++;
      continue;
    }
    if (c === ',') {
      tokens.push({ type: 'comma' });
      i++;
      continue;
    }
    if (c === ':' && raw[i + 1] === '=') {
      tokens.push({ type: 'assign' });
      i += 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < raw.length && raw[j] !== '"') {
        if (raw[j] === '\\' && j + 1 < raw.length) {
          value += raw[j + 1];
          j += 2;
        } else {
          value += raw[j];
          j++;
        }
      }
      tokens.push({ type: 'string', value });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < raw.length && !/[\s(),]/.test(raw[j] as string)) j++;
    tokens.push({ type: 'word', value: raw.slice(i, j) });
    i = j;
  }
  return tokens;
}

// ---- expression AST + parser --------------------------------------------

type Expr = { kind: 'path'; path: string } | { kind: 'string'; value: string } | { kind: 'call'; name: string; args: Expr[] };

// A parenthesized group's content is parsed with this same rule - it's
// either a single path/string (`(.Query.Album)`) or a nested call
// (`(eq .Result.cat "movie")`), which is exactly what makes
// `or (eq A "x") (or (eq B "y") (eq C "z"))`-style nesting fall out for free.
function parseTokens(tokens: Token[]): Expr {
  if (tokens.length === 0) throw new Error('template: empty expression');

  const first = tokens[0] as Token;
  if (tokens.length === 1) {
    if (first.type === 'word') return { kind: 'path', path: first.value };
    if (first.type === 'string') return { kind: 'string', value: first.value };
    throw new Error('template: unexpected token in expression');
  }

  if (first.type !== 'word') throw new Error('template: expected a function/keyword name');

  const args: Expr[] = [];
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i] as Token;
    if (t.type === 'word') {
      args.push({ kind: 'path', path: t.value });
      i++;
      continue;
    }
    if (t.type === 'string') {
      args.push({ kind: 'string', value: t.value });
      i++;
      continue;
    }
    if (t.type === 'lparen') {
      let depth = 1;
      let j = i + 1;
      while (j < tokens.length && depth > 0) {
        if (tokens[j]?.type === 'lparen') depth++;
        if (tokens[j]?.type === 'rparen') depth--;
        j++;
      }
      if (depth !== 0) throw new Error('template: unbalanced parentheses');
      args.push(parseTokens(tokens.slice(i + 1, j - 1)));
      i = j;
      continue;
    }
    throw new Error(`template: unexpected token at position ${i}`);
  }

  return { kind: 'call', name: first.value, args };
}

// ---- template node tree ---------------------------------------------------

type TemplateNode =
  | { kind: 'text'; value: string }
  | { kind: 'action'; expr: Expr }
  | { kind: 'if'; cond: Expr; then: TemplateNode[]; else: TemplateNode[] }
  | { kind: 'range'; indexVar?: string; itemVar?: string; list: Expr; body: TemplateNode[] };

type IfFrame = { kind: 'if'; cond: Expr; then: TemplateNode[]; else: TemplateNode[]; inElse: boolean };
type RangeFrame = { kind: 'range'; indexVar?: string; itemVar?: string; list: Expr; body: TemplateNode[] };
type Frame = IfFrame | RangeFrame;

function splitActions(template: string): ({ type: 'text'; value: string } | { type: 'action'; raw: string })[] {
  const parts: ({ type: 'text'; value: string } | { type: 'action'; raw: string })[] = [];
  const re = /\{\{(.*?)\}\}/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    if (m.index > lastIndex) parts.push({ type: 'text', value: template.slice(lastIndex, m.index) });
    parts.push({ type: 'action', raw: (m[1] as string).trim() });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < template.length) parts.push({ type: 'text', value: template.slice(lastIndex) });
  return parts;
}

function buildTree(template: string): TemplateNode[] {
  const root: TemplateNode[] = [];
  const stack: { frame: Frame; parent: TemplateNode[] }[] = [];

  const currentTarget = (): TemplateNode[] => {
    if (stack.length === 0) return root;
    const top = (stack[stack.length - 1] as { frame: Frame }).frame;
    return top.kind === 'if' ? (top.inElse ? top.else : top.then) : top.body;
  };

  for (const part of splitActions(template)) {
    if (part.type === 'text') {
      if (part.value) currentTarget().push({ kind: 'text', value: part.value });
      continue;
    }

    const tokens = tokenize(part.raw);
    if (tokens.length === 0) continue;
    const first = tokens[0] as Token;
    const firstWord = first.type === 'word' ? first.value : null;

    if (firstWord === 'end') {
      const popped = stack.pop();
      if (!popped) throw new Error('template: unmatched {{ end }}');
      const node: TemplateNode =
        popped.frame.kind === 'if'
          ? { kind: 'if', cond: popped.frame.cond, then: popped.frame.then, else: popped.frame.else }
          : { kind: 'range', indexVar: popped.frame.indexVar, itemVar: popped.frame.itemVar, list: popped.frame.list, body: popped.frame.body };
      popped.parent.push(node);
      continue;
    }

    if (firstWord === 'else') {
      const top = stack[stack.length - 1]?.frame;
      if (!top || top.kind !== 'if') throw new Error('template: unexpected {{ else }} outside an {{ if }}');
      top.inElse = true;
      continue;
    }

    if (firstWord === 'if') {
      const cond = parseTokens(tokens.slice(1));
      const frame: Frame = { kind: 'if', cond, then: [], else: [], inElse: false };
      stack.push({ frame, parent: currentTarget() });
      continue;
    }

    if (firstWord === 'range') {
      let rest = tokens.slice(1);
      let indexVar: string | undefined;
      let itemVar: string | undefined;
      if (rest[0]?.type === 'word' && rest[1]?.type === 'comma' && rest[2]?.type === 'word' && rest[3]?.type === 'assign') {
        indexVar = rest[0].value;
        itemVar = rest[2].value;
        rest = rest.slice(4);
      }
      const list = parseTokens(rest);
      const frame: Frame = { kind: 'range', indexVar, itemVar, list, body: [] };
      stack.push({ frame, parent: currentTarget() });
      continue;
    }

    currentTarget().push({ kind: 'action', expr: parseTokens(tokens) });
  }

  if (stack.length > 0) throw new Error('template: unclosed {{ if }}/{{ range }} block');
  return root;
}

const compileCache = new Map<string, TemplateNode[]>();

function compile(template: string): TemplateNode[] {
  let tree = compileCache.get(template);
  if (!tree) {
    tree = buildTree(template);
    compileCache.set(template, tree);
  }
  return tree;
}

// ---- evaluation -----------------------------------------------------------

function isEmpty(value: string): boolean {
  return value === '';
}

function resolvePath(path: string, ctx: EvalContext): string {
  if (path === '.') return ctx.dot ?? '';
  if (path.startsWith('$')) return ctx.vars?.[path] ?? '';
  if (!path.startsWith('.')) return path; // a bareword that isn't a path - treat literally

  const parts = path.slice(1).split('.');
  const root = parts[0];

  if (root === 'True') return 'True';
  if (root === 'False') return '';
  if (root === 'Today' && parts[1] === 'Year') return String(new Date().getUTCFullYear());
  if (root === 'Keywords') return ctx.Keywords;
  if (root === 'Categories') return ctx.Categories.join(',');
  if (root === 'Config') return ctx.Config[parts[1] ?? ''] ?? '';
  if (root === 'Result') return ctx.Result[parts[1] ?? ''] ?? '';
  if (root === 'Vars') return ctx.Vars?.[parts[1] ?? ''] ?? '';
  if (root === 'Now') return ctx.Now ?? '';
  if (root === 'Query') return ctx.Query[parts.slice(1).join('.')] ?? '';
  if (root === 'DownloadUri') {
    if (!ctx.DownloadUri) return '';
    if (parts[1] === 'Query') return ctx.DownloadUri.Query[parts[2] ?? ''] ?? '';
    const key = parts[1] as keyof DownloadUri;
    const value = ctx.DownloadUri[key];
    return typeof value === 'string' ? value : '';
  }

  return '';
}

// Every documented list-valued variable is .Categories - join/range fall
// back to a single-element list of the resolved string for anything else,
// rather than throwing, since a definition ranging over something this
// engine doesn't model as a list is more useful degraded than fatal.
function resolveListArg(expr: Expr, ctx: EvalContext): string[] {
  if (expr.kind === 'path' && expr.path === '.Categories') return ctx.Categories;
  const value = evalExpr(expr, ctx);
  return value === '' ? [] : [value];
}

function evalCall(name: string, args: Expr[], ctx: EvalContext): string {
  switch (name) {
    case 'eq':
      return evalExpr(args[0] as Expr, ctx) === evalExpr(args[1] as Expr, ctx) ? 'True' : '';
    case 'ne':
      return evalExpr(args[0] as Expr, ctx) !== evalExpr(args[1] as Expr, ctx) ? 'True' : '';
    case 'or':
      for (const a of args) {
        const v = evalExpr(a, ctx);
        if (!isEmpty(v)) return v;
      }
      return '';
    case 'and': {
      let last = '';
      for (const a of args) {
        last = evalExpr(a, ctx);
        if (isEmpty(last)) return '';
      }
      return last;
    }
    case 'join':
      return resolveListArg(args[0] as Expr, ctx).join(evalExpr(args[1] as Expr, ctx));
    default: {
      if (!isKnownFilter(name)) throw new Error(`template: unknown function "${name}"`);
      const value = evalExpr(args[0] as Expr, ctx);
      const filterArgs = args.slice(1).map((a) => evalExpr(a, ctx));
      const asFilterArgs: FilterArgs = filterArgs.length === 0 ? undefined : filterArgs.length === 1 ? filterArgs[0] : filterArgs;
      return applyFilter(name, asFilterArgs, value);
    }
  }
}

function evalExpr(expr: Expr, ctx: EvalContext): string {
  if (expr.kind === 'string') return expr.value;
  if (expr.kind === 'path') return resolvePath(expr.path, ctx);
  return evalCall(expr.name, expr.args, ctx);
}

function render(nodes: TemplateNode[], ctx: EvalContext): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') {
      out += node.value;
    } else if (node.kind === 'action') {
      out += evalExpr(node.expr, ctx);
    } else if (node.kind === 'if') {
      out += render(isEmpty(evalExpr(node.cond, ctx)) ? node.else : node.then, ctx);
    } else {
      const list = resolveListArg(node.list, ctx);
      for (let idx = 0; idx < list.length; idx++) {
        const item = list[idx] as string;
        const vars = { ...ctx.vars };
        if (node.indexVar) vars[node.indexVar] = String(idx);
        if (node.itemVar) vars[node.itemVar] = item;
        out += render(node.body, { ...ctx, dot: item, vars });
      }
    }
  }
  return out;
}

export function renderTemplate(template: string, ctx: TemplateContext): string {
  return render(compile(template), ctx);
}
