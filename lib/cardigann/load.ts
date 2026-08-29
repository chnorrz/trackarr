import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { Operation } from 'fast-json-patch';
import { compileSchema } from './ajv.js';
import { applySchemaExtensions } from './patch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The trackarr-owned extensions (sha256/concat filters, search.vars, ...)
// layered onto whatever base schema a given definitions directory carries -
// same extensions regardless of which upstream schema they're applied to,
// so this is loaded once here rather than per schema directory.
const extensions = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema-extensions.json'), 'utf8')) as Operation[];

// "Bundled" means the schema shipped alongside this repo's own
// definitions/ directory - resolved relative to cwd, same convention
// cli.ts/config-cli.ts already use for repoDefinitionsDir, and independent
// of whatever directory a given caller passes as its own repoDefinitionsDir
// override (test fixtures in particular use temp dirs that don't carry
// their own schema.json - they're meant to validate against this one).
function defaultSchemaPath(): string {
  return path.resolve('definitions', 'schema.json');
}

interface CompiledSchemaPair {
  /** Validates against the schema exactly as it ships upstream. */
  strict: ValidateFunction;
  /** strict + lib/cardigann/schema-extensions.json applied on top. */
  extended: ValidateFunction;
}

// Keyed by resolved schema.json path - a definitions directory's schema
// rarely changes at runtime, so compiling it once per distinct path (rather
// than once globally, as before phase 2) is enough while still supporting
// multiple directories (a volume mount's own schema.json vs the bundled
// one) with a single validator instance each.
const schemaCache = new Map<string, CompiledSchemaPair>();

function loadSchemaPair(schemaPath: string): CompiledSchemaPair {
  const resolved = path.resolve(schemaPath);
  const cached = schemaCache.get(resolved);
  if (cached) return cached;

  if (!fs.existsSync(resolved)) {
    throw new Error(`Cardigann: no schema.json found at ${resolved}`);
  }

  const base = JSON.parse(fs.readFileSync(resolved, 'utf8')) as object;
  const extended = applySchemaExtensions(base, extensions);
  const pair: CompiledSchemaPair = { strict: compileSchema(base), extended: compileSchema(extended) };
  schemaCache.set(resolved, pair);
  return pair;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`);
}

// Mirrors a quirk documented in Prowlarr's own Python validator
// (CONTRIBUTING.md): the schema requires string values inside `options` and
// `case` maps, but an unquoted YAML `true`/`false` parses as a JS boolean,
// not a string - e.g. `options: { hd: true }` needs to mean the string
// "true". Recursing only into objects keyed "options"/"case" leaves fields
// that are genuinely boolean-typed elsewhere in the schema (e.g.
// caps.allowrawsearch) untouched.
function normalizeBooleanMaps(node: unknown): void {
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((key === 'options' || key === 'case') && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'boolean') (value as Record<string, unknown>)[k] = String(v);
      }
    }
    normalizeBooleanMaps(value);
  }
}

export interface LoadedDefinition {
  file: string;
  id: string;
  definition: Record<string, unknown>;
  /** true if valid against the schema exactly as it ships upstream (no
   * trackarr extensions needed) - i.e. this definition would also run
   * unmodified under Prowlarr/Jackett. */
  portable: boolean;
}

export interface RejectedDefinition {
  file: string;
  errors: string[];
}

export interface LoadResult {
  valid: LoadedDefinition[];
  invalid: RejectedDefinition[];
}

export type ValidatedYaml =
  | { ok: true; id: string; definition: Record<string, unknown>; portable: boolean }
  | { ok: false; errors: string[] };

// The one place both the directory scanner below and lib/cardigann/resolve.ts
// (single definition, by id, from a local dir or a fetched URL) run schema
// validation - so both paths reject exactly the same things the same way.
//
// schemaPath defaults to the bundled definitions/schema.json so existing
// call sites (most of them) don't need to know about schema resolution at
// all; resolve.ts passes an explicit path when a definition's own directory
// (a DEFINITIONS_DIR volume mount) carries a schema.json of its own.
//
// A definition is tried against the schema exactly as it ships upstream
// first; only on failure is it retried against that same schema with
// lib/cardigann/schema-extensions.json applied, so trackarr-only fields
// (search.vars, the sha256/concat filters, ...) can validate. Whichever one
// it validated under decides `portable`.
export function validateDefinitionYaml(raw: string, schemaPath: string = defaultSchemaPath()): ValidatedYaml {
  let parsed: unknown;

  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    return { ok: false, errors: [`YAML parse error: ${err instanceof Error ? err.message : String(err)}`] };
  }

  normalizeBooleanMaps(parsed);

  const { strict, extended } = loadSchemaPair(schemaPath);

  let portable = true;
  if (!strict(parsed)) {
    portable = false;
    if (!extended(parsed)) {
      // The extended schema is a superset, so once both have failed its
      // errors are the ones that matter - a strict-only complaint like
      // "vars is not a known property" would otherwise mask the real one.
      return { ok: false, errors: formatErrors(extended.errors) };
    }
  }

  const definition = parsed as Record<string, unknown>;
  const id = definition.id;

  if (typeof id !== 'string') {
    return { ok: false, errors: ['missing or non-string id after schema validation (unexpected)'] };
  }

  return { ok: true, id, definition, portable };
}

// schemaPath defaults the same way validateDefinitionYaml does (see there);
// pass an explicit one to scan a self-contained directory that carries its
// own schema.json rather than validating everything in it against the
// bundled one.
export function loadDefinitions(dir: string, schemaPath: string = defaultSchemaPath()): LoadResult {
  const valid: LoadedDefinition[] = [];
  const invalid: RejectedDefinition[] = [];

  if (!fs.existsSync(dir)) return { valid, invalid };

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of files) {
    const full = path.join(dir, file);
    let raw: string;

    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (err) {
      invalid.push({ file, errors: [`read error: ${err instanceof Error ? err.message : String(err)}`] });
      continue;
    }

    const result = validateDefinitionYaml(raw, schemaPath);
    if (!result.ok) {
      invalid.push({ file, errors: result.errors });
      continue;
    }

    valid.push({ file, id: result.id, definition: result.definition, portable: result.portable });
  }

  return { valid, invalid };
}
