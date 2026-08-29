import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { applySchemaExtensions } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'patch.js'));

test('applySchemaExtensions: appends a new enum value', () => {
  const base = { definitions: { X: { properties: { name: { enum: ['a', 'b'] } } } } };
  const patched = applySchemaExtensions(base, [{ op: 'add', path: '/definitions/X/properties/name/enum/-', value: 'c' }]);
  assert.deepEqual(patched.definitions.X.properties.name.enum, ['a', 'b', 'c']);
});

test('applySchemaExtensions: an enum value already present upstream is skipped, not duplicated', () => {
  const base = { definitions: { X: { properties: { name: { enum: ['a', 'b'] } } } } };
  const patched = applySchemaExtensions(base, [{ op: 'add', path: '/definitions/X/properties/name/enum/-', value: 'b' }]);
  assert.deepEqual(patched.definitions.X.properties.name.enum, ['a', 'b']);
});

test('applySchemaExtensions: adds a new property at a path that does not exist yet', () => {
  const base = { definitions: { Search: { properties: { path: { type: 'string' } } } } };
  const patched = applySchemaExtensions(base, [{ op: 'add', path: '/definitions/Search/properties/vars', value: { type: 'object' } }]);
  assert.deepEqual(patched.definitions.Search.properties.vars, { type: 'object' });
});

test('applySchemaExtensions: a non-append "add" whose target already has a value throws, rather than silently shadowing it', () => {
  const base = { definitions: { Search: { properties: { vars: { type: 'string' } } } } };
  assert.throws(
    () => applySchemaExtensions(base, [{ op: 'add', path: '/definitions/Search/properties/vars', value: { type: 'object' } }]),
    /already exists upstream/
  );
});

test('applySchemaExtensions: the original schema object passed in is left untouched', () => {
  const base = { definitions: { X: { properties: { name: { enum: ['a'] } } } } };
  applySchemaExtensions(base, [{ op: 'add', path: '/definitions/X/properties/name/enum/-', value: 'b' }]);
  assert.deepEqual(base.definitions.X.properties.name.enum, ['a']);
});
