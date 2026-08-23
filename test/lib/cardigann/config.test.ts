import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { loadConfig } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'config.js'));

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardigann-config-test-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('loadConfig: a missing file returns null - "no Cardigann indexers", not an error', () => {
  assert.equal(loadConfig('/definitely/does/not/exist/trackarr.yml'), null);
});

test('loadConfig: a well-formed config parses into the expected shape', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'trackarr.yml');
    fs.writeFileSync(file, `
indexers:
  kickass:
    definition: kickasstorrents-to
  tpb-audio:
    definition: thepiratebay
    source: prowlarr:v11
    link: https://thepiratebay.org/
    config:
      top100: "100"
`);
    const config = loadConfig(file);
    assert.equal(config?.indexers.kickass?.definition, 'kickasstorrents-to');
    assert.equal(config?.indexers['tpb-audio']?.config?.top100, '100');
  });
});

test('loadConfig: malformed YAML throws with the file path in the message', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'trackarr.yml');
    fs.writeFileSync(file, 'indexers: [unclosed');
    assert.throws(() => loadConfig(file), /trackarr\.yml.*YAML parse error/s);
  });
});

test('loadConfig: an unknown top-level key is rejected (additionalProperties: false)', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'trackarr.yml');
    fs.writeFileSync(file, 'indexers: {}\nnotARealKey: true\n');
    assert.throws(() => loadConfig(file));
  });
});

test('loadConfig: an indexer key not matching the id pattern is rejected', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'trackarr.yml');
    fs.writeFileSync(file, 'indexers:\n  "Not Valid!":\n    definition: x\n');
    assert.throws(() => loadConfig(file));
  });
});

test('loadConfig: an indexer entry missing the required "definition" field is rejected', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'trackarr.yml');
    fs.writeFileSync(file, 'indexers:\n  kickass:\n    source: prowlarr:v11\n');
    assert.throws(() => loadConfig(file));
  });
});

test('loadConfig: duplicate indexer keys are rejected by the YAML parser itself', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'trackarr.yml');
    fs.writeFileSync(file, 'indexers:\n  tpb:\n    definition: a\n  tpb:\n    definition: b\n');
    assert.throws(() => loadConfig(file), /unique/i);
  });
});
