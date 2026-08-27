import { Ajv2019 } from 'ajv/dist/2019.js';
import type { ValidateFunction } from 'ajv';
import ajvFormatsImport from 'ajv-formats';
const addFormats = ajvFormatsImport as unknown as (ajv: Ajv2019) => void;

export function compileSchema(schema: object): ValidateFunction {
  const ajv = new Ajv2019({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}
