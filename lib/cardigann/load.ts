import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
// Ajv's default export only understands draft-07; the vendored Prowlarr
// schema declares draft/2019-09, so this build is required.
import { Ajv2019 } from 'ajv/dist/2019.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
// Without this, format: "uri" etc. on schema.json's fields (links,
// legacylinks, ...) is silently skipped rather than enforced - Prowlarr's
// own documented ajv-cli usage pairs the two for the same reason.
//
// ajv-formats' CJS output is `module.exports = formatsPlugin` with `.default`
// re-pointed at itself for interop; under NodeNext this resolves at the type
// level to a non-callable namespace, though the runtime value (verified via
// the compiled dist/index.js) really is the callable function. Cast rather
// than fight the resolver - a known friction point for this package, not a
// bug in our code.
import ajvFormatsImport from 'ajv-formats';
const addFormats = ajvFormatsImport as unknown as (ajv: Ajv2019) => void;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8')) as object;

const ajv = new Ajv2019({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema: ValidateFunction = ajv.compile(schema);

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
}

export interface RejectedDefinition {
  file: string;
  errors: string[];
}

export interface LoadResult {
  valid: LoadedDefinition[];
  invalid: RejectedDefinition[];
}

export function loadDefinitions(dir: string): LoadResult {
  const valid: LoadedDefinition[] = [];
  const invalid: RejectedDefinition[] = [];

  if (!fs.existsSync(dir)) return { valid, invalid };

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of files) {
    const full = path.join(dir, file);
    let parsed: unknown;

    try {
      parsed = YAML.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      invalid.push({ file, errors: [`YAML parse error: ${err instanceof Error ? err.message : String(err)}`] });
      continue;
    }

    normalizeBooleanMaps(parsed);

    if (!validateSchema(parsed)) {
      const errors = (validateSchema.errors || []).map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message}`);
      invalid.push({ file, errors });
      continue;
    }

    const definition = parsed as Record<string, unknown>;
    const id = definition.id;

    if (typeof id !== 'string') {
      invalid.push({ file, errors: ['missing or non-string id after schema validation (unexpected)'] });
      continue;
    }

    valid.push({ file, id, definition });
  }

  return { valid, invalid };
}
