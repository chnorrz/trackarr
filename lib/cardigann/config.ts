import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { ErrorObject } from 'ajv';
import { compileSchema } from './ajv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'config-schema.json'), 'utf8')) as object;
const validateSchema = compileSchema(schema);

export interface IndexerConfigEntry {
  definition: string;
  source?: string;
  link?: string;
  config?: Record<string, string | number | boolean>;
}

export interface TrackarrConfig {
  indexers: Record<string, IndexerConfigEntry>;
}

// A missing config file is not an error - it means "no Cardigann indexers",
// and the three hand-written providers behave exactly as they always have.
// A *present but invalid* file is fatal (refuse to boot): unlike a single
// bad definition, a broken config is something the operator just edited and
// should see immediately, not have silently ignored.
export function loadConfig(configPath: string): TrackarrConfig | null {
  if (!fs.existsSync(configPath)) return null;

  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`${configPath}: YAML parse error: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }

  if (!validateSchema(parsed)) {
    const errors = (validateSchema.errors || []).map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message}`);
    throw new Error(`${configPath}: ${errors.join('; ')}`);
  }

  return parsed as TrackarrConfig;
}
