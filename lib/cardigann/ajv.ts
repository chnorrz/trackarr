// Ajv's default export only understands draft-07; both the vendored Prowlarr
// definition schema and our own config schema declare draft/2019-09, so this
// build is required.
import { Ajv2019 } from 'ajv/dist/2019.js';
import type { ValidateFunction } from 'ajv';
// Without this, format: "uri" etc. is silently skipped rather than enforced
// - Prowlarr's own documented ajv-cli usage pairs the two for the same reason.
//
// ajv-formats' CJS output is `module.exports = formatsPlugin` with `.default`
// re-pointed at itself for interop; under NodeNext this resolves at the type
// level to a non-callable namespace, though the runtime value (verified via
// the compiled dist/index.js) really is the callable function. Cast rather
// than fight the resolver - a known friction point for this package, not a
// bug in our code.
import ajvFormatsImport from 'ajv-formats';
const addFormats = ajvFormatsImport as unknown as (ajv: Ajv2019) => void;

export function compileSchema(schema: object): ValidateFunction {
  const ajv = new Ajv2019({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}
