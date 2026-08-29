import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { validateIndexerConfig } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'validate-config.js'));

function resolved(definitionOverrides: Record<string, unknown> = {}) {
  return {
    definitionId: 'thepiratebay',
    from: '/fake/thepiratebay.yml',
    definition: {
      links: ['https://thepiratebay.org/', 'https://tpb.re/'],
      settings: [
        { name: 'apiurl', type: 'text', default: 'apibay.org' },
        { name: 'top100', type: 'select', default: 'recent', options: { recent: 'All', '100': 'Audio' } },
        { name: 'uploader', type: 'text' }
      ],
      ...definitionOverrides
    }
  };
}

test('validateIndexerConfig: a clean entry produces no reasons', () => {
  const entry = { definition: 'thepiratebay', config: { apiurl: 'apibay.org', top100: '100' } };
  assert.deepEqual(validateIndexerConfig('tpb', entry, resolved()), []);
});

test('validateIndexerConfig: link must be one of the definition\'s own links[]', () => {
  const entry = { definition: 'thepiratebay', link: 'https://not-a-real-mirror.example/' };
  const reasons = validateIndexerConfig('tpb', entry, resolved());
  assert.match(reasons[0], /not in thepiratebay's links/);
});

test('validateIndexerConfig: link that IS in links[] passes', () => {
  const entry = { definition: 'thepiratebay', link: 'https://tpb.re/' };
  assert.deepEqual(validateIndexerConfig('tpb', entry, resolved()), []);
});

test('validateIndexerConfig: a config key not in the definition\'s settings is rejected, listing the real ones', () => {
  const entry = { definition: 'thepiratebay', config: { nonexistent: 'x' } };
  const reasons = validateIndexerConfig('tpb', entry, resolved());
  assert.match(reasons[0], /config\.nonexistent: not a known setting/);
  assert.match(reasons[0], /apiurl, top100, uploader/);
});

test('validateIndexerConfig: a select value outside the declared options is rejected, listing valid ones', () => {
  const entry = { definition: 'thepiratebay', config: { top100: 'not-a-real-option' } };
  const reasons = validateIndexerConfig('tpb', entry, resolved());
  assert.match(reasons[0], /config\.top100: "not-a-real-option" is not one of/);
  // Integer-like object keys ("100") always iterate before non-numeric ones
  // in JS, regardless of insertion order - not a bug, just what Object.keys()
  // does, so the real values are checked individually rather than as a
  // fixed-order substring.
  assert.match(reasons[0], /\brecent\b/);
  assert.match(reasons[0], /\b100\b/);
});

test('validateIndexerConfig: a select value that IS one of the options passes', () => {
  const entry = { definition: 'thepiratebay', config: { top100: 'recent' } };
  assert.deepEqual(validateIndexerConfig('tpb', entry, resolved()), []);
});

test('validateIndexerConfig: a non-select setting accepts any value - only select is options-checked', () => {
  const entry = { definition: 'thepiratebay', config: { apiurl: 'literally.anything' } };
  assert.deepEqual(validateIndexerConfig('tpb', entry, resolved()), []);
});

test('validateIndexerConfig: a definition with no settings[] at all rejects any config key', () => {
  const entry = { definition: 'foo', config: { x: 'y' } };
  const reasons = validateIndexerConfig('foo-inst', entry, resolved({ settings: undefined }));
  assert.match(reasons[0], /this definition has no settings/);
});

test('validateIndexerConfig: no link and no config at all is fine - both are optional', () => {
  const entry = { definition: 'thepiratebay' };
  assert.deepEqual(validateIndexerConfig('tpb', entry, resolved()), []);
});

test('validateIndexerConfig: multiple reasons accumulate rather than stopping at the first', () => {
  const entry = { definition: 'thepiratebay', link: 'https://bad.example/', config: { nonexistent: 'x' } };
  const reasons = validateIndexerConfig('tpb', entry, resolved());
  assert.equal(reasons.length, 2);
});
