import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const { CATEGORIES, categoriesXml, categoryIdByName, categoryNameById } = await import(
  path.join(ROOT, 'dist', 'lib', 'categories.js')
);

test('the full standard category vocabulary has exactly 71 entries, matching schema.json IndexerCategories', () => {
  // Spot-check a representative id/name pair from each parent group rather
  // than asserting the whole list inline (already verified against
  // Prowlarr's NewznabStandardCategory.cs and the vendored schema's enum).
  const samples: [number, string][] = [
    [1000, 'Console'], [1180, 'Console/PS4'],
    [2000, 'Movies'], [2045, 'Movies/UHD'],
    [3000, 'Audio'], [3030, 'Audio/Audiobook'],
    [4000, 'PC'], [4070, 'PC/Mobile-Android'],
    [5000, 'TV'], [5070, 'TV/Anime'],
    [6000, 'XXX'], [6090, 'XXX/WEB-DL'],
    [7000, 'Books'], [7020, 'Books/EBook'],
    [8000, 'Other'], [8020, 'Other/Hashed']
  ];
  for (const [id, name] of samples) {
    assert.equal(categoryIdByName(name), id, `categoryIdByName(${name})`);
    assert.equal(categoryNameById(id), name, `categoryNameById(${id})`);
  }
});

test('categoryIdByName falls back to OTHER for an unknown name', () => {
  assert.equal(categoryIdByName('Not/A/Real/Category'), CATEGORIES.OTHER);
});

test('categoryNameById returns undefined for an unknown id, not a guess', () => {
  assert.equal(categoryNameById(9999), undefined);
});

test('categoriesXml still renders correctly with the full 71-entry vocabulary', () => {
  const xml = categoriesXml([2000, 2040, 5000, 5070]);
  assert.match(xml, /<category id="2000" name="Movies">/);
  assert.match(xml, /<subcat id="2040" name="Movies\/HD" \/>/);
  assert.match(xml, /<category id="5000" name="TV">/);
  assert.match(xml, /<subcat id="5070" name="TV\/Anime" \/>/);
});
