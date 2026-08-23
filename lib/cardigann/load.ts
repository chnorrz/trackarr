import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { ErrorObject } from 'ajv';
import { compileSchema } from './ajv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'schema.json'), 'utf8')) as object;
const validateSchema = compileSchema(schema);

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

export type ValidatedYaml =
  | { ok: true; id: string; definition: Record<string, unknown> }
  | { ok: false; errors: string[] };

// The one place both the directory scanner below and lib/cardigann/resolve.ts
// (single definition, by id, from a local dir or a fetched URL) run schema
// validation - kept as a single Ajv instance/compiled validator rather than
// two, so both paths reject exactly the same things the same way.
export function validateDefinitionYaml(raw: string): ValidatedYaml {
  let parsed: unknown;

  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    return { ok: false, errors: [`YAML parse error: ${err instanceof Error ? err.message : String(err)}`] };
  }

  normalizeBooleanMaps(parsed);

  if (!validateSchema(parsed)) {
    const errors = (validateSchema.errors || []).map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message}`);
    return { ok: false, errors };
  }

  const definition = parsed as Record<string, unknown>;
  const id = definition.id;

  if (typeof id !== 'string') {
    return { ok: false, errors: ['missing or non-string id after schema validation (unexpected)'] };
  }

  return { ok: true, id, definition };
}

export function loadDefinitions(dir: string): LoadResult {
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

    const result = validateDefinitionYaml(raw);
    if (!result.ok) {
      invalid.push({ file, errors: result.errors });
      continue;
    }

    valid.push({ file, id: result.id, definition: result.definition });
  }

  return { valid, invalid };
}
