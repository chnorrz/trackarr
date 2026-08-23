import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const { CATEGORIES, matchCategory } = await import(path.join(ROOT, 'dist', 'lib', 'categories.js'));

test('matchCategory returns the first matching rule, case-insensitively', () => {
  const rules = [
    [['tv'], CATEGORIES.TV],
    [['movie'], CATEGORIES.MOVIES]
  ];
  assert.equal(matchCategory('Some TV Show', rules), CATEGORIES.TV);
  assert.equal(matchCategory('A MOVIE', rules), CATEGORIES.MOVIES);
});

test('matchCategory respects rule order (first match wins)', () => {
  const rules = [
    [['tv'], CATEGORIES.TV],
    [['hd', 'movie'], CATEGORIES.MOVIES]
  ];
  assert.equal(matchCategory('flaticon-tv flaticon-hd', rules), CATEGORIES.TV);
});

test('matchCategory falls back to OTHER with no match or empty input', () => {
  const rules: [string[], number][] = [[['tv'], CATEGORIES.TV]];
  assert.equal(matchCategory('music', rules), CATEGORIES.OTHER);
  assert.equal(matchCategory('', rules), CATEGORIES.OTHER);
  assert.equal(matchCategory(undefined, rules), CATEGORIES.OTHER);
});
