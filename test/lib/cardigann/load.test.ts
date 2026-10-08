import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { validateDefinitionYaml, loadDefinitions } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'load.js'));

const VALID_YAML = `
id: test-tracker
name: Test Tracker
description: "A test tracker"
language: en-US
type: public
encoding: UTF-8
links:
  - https://test.example/
caps:
  categorymappings:
    - {id: 1, cat: Movies, desc: "Movies"}
  modes:
    search: [q]
search:
  paths:
    - path: search?q={{ .Keywords }}
  rows:
    selector: tr
  fields:
    title:
      selector: a
    size:
      text: "0 B"
    seeders:
      text: "0"
    category:
      text: "1"
    download:
      selector: a
      attribute: href
`;

test('validateDefinitionYaml: a well-formed definition passes, returns its id, and is portable (valid under the upstream schema as-is)', () => {
  const result = validateDefinitionYaml(VALID_YAML);
  assert.equal(result.ok, true);
  assert.equal(result.id, 'test-tracker');
  assert.equal(result.definition.name, 'Test Tracker');
  assert.equal(result.portable, true);
});

test('validateDefinitionYaml: search.vars (a trackarr extension, not in the upstream schema) validates, but as not portable', () => {
  const withVars = VALID_YAML.replace(
    'search:\n  paths:',
    'search:\n  vars:\n    token: { selector: "meta[name=csrf-token]", attribute: content }\n  paths:'
  );
  const result = validateDefinitionYaml(withVars);
  assert.equal(result.ok, true, JSON.stringify(result.ok === false ? result.errors : null));
  assert.equal(result.portable, false);
});

test('validateDefinitionYaml: a filters.name of "sha256" (a trackarr extension) validates, but as not portable', () => {
  const withSha256 = VALID_YAML.replace(
    'download:\n      selector: a\n      attribute: href',
    'download:\n      selector: a\n      attribute: href\n      filters:\n        - name: sha256'
  );
  const result = validateDefinitionYaml(withSha256);
  assert.equal(result.ok, true, JSON.stringify(result.ok === false ? result.errors : null));
  assert.equal(result.portable, false);
});

test('validateDefinitionYaml: a genuinely invalid definition still fails even against the extended schema', () => {
  const result = validateDefinitionYaml(VALID_YAML + '\nnotARealFieldAtAll: true\n');
  assert.equal(result.ok, false);
});

test('validateDefinitionYaml: an explicit schemaPath that does not exist throws, naming the path', () => {
  assert.throws(() => validateDefinitionYaml(VALID_YAML, '/definitely/does/not/exist/schema.json'), /no schema\.json found/);
});

test('validateDefinitionYaml: malformed YAML is rejected with a parse error, not a crash', () => {
  const result = validateDefinitionYaml('id: [unclosed');
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /YAML parse error/);
});

test('validateDefinitionYaml: schema-invalid (missing required field) is rejected with Ajv details', () => {
  const withoutName = VALID_YAML.replace(/^name: .*$/m, '');
  const result = validateDefinitionYaml(withoutName);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test('validateDefinitionYaml: additionalProperties: false rejects an unknown top-level key', () => {
  const result = validateDefinitionYaml(VALID_YAML + '\nnotARealField: true\n');
  assert.equal(result.ok, false);
});

test('validateDefinitionYaml: an unquoted boolean inside options: is normalized to a string before validation', () => {
  const withOptions = VALID_YAML + `
settings:
  - name: hd
    type: select
    label: HD
    options:
      "1080p": true
`;
  const result = validateDefinitionYaml(withOptions);
  assert.equal(result.ok, true, JSON.stringify(result.ok === false ? result.errors : null));
  const settings = result.definition.settings as { options: Record<string, unknown> }[];
  assert.equal(settings[0]?.options['1080p'], 'true');
  assert.equal(typeof settings[0]?.options['1080p'], 'string');
});

test('validateDefinitionYaml: a boolean outside options:/case: is left alone (e.g. caps.allowrawsearch)', () => {
  const withAllowRaw = VALID_YAML.replace('caps:\n', 'caps:\n  allowrawsearch: true\n');
  const result = validateDefinitionYaml(withAllowRaw);
  assert.equal(result.ok, true);
  assert.equal((result.definition.caps as { allowrawsearch: unknown }).allowrawsearch, true);
});

test('loadDefinitions: scans a directory, separating valid from invalid files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardigann-load-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'good.yml'), VALID_YAML.replace('test-tracker', 'good'));
    fs.writeFileSync(path.join(dir, 'bad.yml'), 'id: [unclosed');
    fs.writeFileSync(path.join(dir, 'not-yaml.txt'), 'ignored - wrong extension');

    const { valid, invalid } = loadDefinitions(dir);

    assert.equal(valid.length, 1);
    assert.equal(valid[0].id, 'good');
    assert.equal(valid[0].portable, true);
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0].file, 'bad.yml');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDefinitions: a nonexistent directory returns empty results, not a throw', () => {
  const result = loadDefinitions('/definitely/does/not/exist/xyz');
  assert.deepEqual(result, { valid: [], invalid: [] });
});
