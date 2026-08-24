// fast-json-patch's CJS entry point builds its exports via
// `Object.assign(exports, core)` (not statically analyzable), so under
// Node's ESM interop only a default export is seen - same friction
// documented in ajv.ts for ajv-formats. Import the default and destructure
// rather than the named exports the .d.ts advertises.
import fastJsonPatch, { type Operation } from 'fast-json-patch';
const { applyPatch, getValueByPointer } = fastJsonPatch;

// Applies lib/cardigann/schema-extensions.json (trackarr's own additions -
// e.g. the sha256/concat filters, search.vars - on top of the vendored
// Prowlarr schema) to produce the "extended" schema that portable:false
// definitions validate against.
//
// The patch document itself is a stock RFC 6902 array, applied with stock
// RFC 6902 semantics via fast-json-patch. The one thing layered on top is a
// precondition pass before applying, since upstream edits this same schema
// in place over time and RFC 6902's "add" would otherwise silently paper
// over that:
//  - an array-append ("op":"add" to a path ending in "/-") whose value is
//    already present in that array is skipped, not applied - upstream
//    having added the same enum value we did is convergence, not conflict.
//  - any other "add" whose target path already holds a value throws - we'd
//    otherwise silently shadow an upstream property of the same name
//    (e.g. if a future schema version adds its own "vars").
// Every other RFC 6902 concern (a path that doesn't resolve at all, etc.)
// is left entirely to fast-json-patch's own applyPatch.
export function applySchemaExtensions(baseSchema: object, patch: readonly Operation[]): object {
  const applicable: Operation[] = [];

  for (const op of patch) {
    if (op.op !== 'add') {
      applicable.push(op);
      continue;
    }

    const segments = op.path.split('/');
    const isAppend = segments[segments.length - 1] === '-';

    if (isAppend) {
      const arrayPath = segments.slice(0, -1).join('/');
      const arr = getValueByPointer(baseSchema, arrayPath);
      if (Array.isArray(arr) && arr.includes(op.value)) {
        console.error(`[cardigann] schema-extensions: skipping ${op.path} = ${JSON.stringify(op.value)} - already present upstream`);
        continue;
      }
      applicable.push(op);
      continue;
    }

    if (getValueByPointer(baseSchema, op.path) !== undefined) {
      throw new Error(`[cardigann] schema-extensions: ${op.path} already exists upstream - refusing to shadow it`);
    }
    applicable.push(op);
  }

  return applyPatch(baseSchema, applicable, true, false).newDocument;
}
