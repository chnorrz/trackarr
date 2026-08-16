import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const { parseSize } = await import(path.join(ROOT, 'dist', 'lib', 'parse.js'));

test('parseSize handles every unit', () => {
  assert.equal(parseSize('500 B'), 500);
  assert.equal(parseSize('1.98 GB'), Math.round(1.98 * 1024 ** 3));
  assert.equal(parseSize('984.36 MB'), Math.round(984.36 * 1024 ** 2));
  assert.equal(parseSize('2 TB'), 2 * 1024 ** 4);
});

test('parseSize returns 0 for unparseable input', () => {
  assert.equal(parseSize(''), 0);
  assert.equal(parseSize('not a size'), 0);
  assert.equal(parseSize(undefined), 0);
  assert.equal(parseSize(null), 0);
});

test('parseSize is case-insensitive on the unit', () => {
  assert.equal(parseSize('1.5 gb'), Math.round(1.5 * 1024 ** 3));
});
