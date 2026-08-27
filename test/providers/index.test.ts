import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const { buildProviderMap } = await import(path.join(ROOT, 'dist', 'providers', 'index.js'));

const SYNTH_DEF_YAML = `
id: synth
name: Synthetic Tracker
description: "test"
language: en-US
type: public
encoding: UTF-8
links:
  - https://synth.example/
caps:
  categorymappings:
    - {id: 1, cat: Movies, desc: "Movies"}
  modes:
    search: [q]
search:
  path: search
  rows:
    selector: tr
  fields:
    title: { selector: a }
    size: { text: "0 B" }
    seeders: { text: "0" }
    category: { text: "1" }
    download: { selector: a, attribute: href }
`;

function withScratch(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trackarr-providers-index-test-'));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function writeConfig(dir: string, yaml: string): string {
  const configFile = path.join(dir, 'trackarr.yml');
  fs.writeFileSync(configFile, yaml);
  return configFile;
}

// definitionsDir maps to resolve.ts's volumeDefinitionsDir - a self-contained
// override directory that must carry its own schema.json.
function giveItsOwnSchema(dir: string): void {
  fs.copyFileSync(path.join(ROOT, 'definitions', 'schema.json'), path.join(dir, 'schema.json'));
}

test('buildProviderMap() with no config file present returns no providers at all - every indexer is config-declared', () =>
  withScratch(async (dir) => {
    const result = await buildProviderMap({ configFile: path.join(dir, 'does-not-exist.yml') });
    assert.deepEqual(result, {});
  }));

test('buildProviderMap() with a valid config resolves a real Cardigann provider', () =>
  withScratch(async (dir) => {
    giveItsOwnSchema(dir);
    fs.writeFileSync(path.join(dir, 'synth.yml'), SYNTH_DEF_YAML);
    const configFile = writeConfig(dir, 'indexers:\n  synth:\n    definition: synth\n');

    const result = await buildProviderMap({ configFile, definitionsDir: dir, cacheDir: path.join(dir, '.cache') });

    assert.deepEqual(Object.keys(result), ['synth']);
    assert.equal(result.synth.id, 'synth');
    assert.equal(result.synth.name, 'Synthetic Tracker');
    assert.deepEqual(result.synth.categories, [2000]);
    assert.equal(typeof result.synth.search, 'function');
    assert.equal(typeof result.synth.resolveMagnet, 'function');
  }));

test('buildProviderMap() excludes one bad indexer entry but still boots the rest', () =>
  withScratch(async (dir) => {
    giveItsOwnSchema(dir);
    fs.writeFileSync(path.join(dir, 'synth.yml'), SYNTH_DEF_YAML);
    const configFile = writeConfig(
      dir,
      'indexers:\n  synth:\n    definition: synth\n  broken:\n    definition: this-definition-does-not-exist\n'
    );

    const result = await buildProviderMap({ configFile, definitionsDir: dir, cacheDir: path.join(dir, '.cache') });

    assert.deepEqual(Object.keys(result), ['synth']);
    assert.equal(result.broken, undefined);
  }));

test('buildProviderMap() throws (refuses to boot) on a schema-invalid config file, rather than skipping it', () =>
  withScratch(async (dir) => {
    const configFile = writeConfig(dir, 'indexers:\n  synth:\n    not_a_real_field: true\n');
    await assert.rejects(
      buildProviderMap({ configFile, definitionsDir: dir, cacheDir: path.join(dir, '.cache') }),
      /must have required property 'definition'/
    );
  }));

test('buildProviderMap() end to end with a real, checked-in fixture (bundled repo fallback, no volume override)', () =>
  withScratch(async (dir) => {
    const configFile = writeConfig(dir, 'indexers:\n  faketracker:\n    definition: faketracker\n');

    // No definitionsDir override here deliberately - this exercises the
    // real bundled-repo fallback path (readLocal(repoDefinitionsDir, ...)),
    // pointed at a fixture dir instead of the real definitions/ so this test
    // doesn't need a vendored copy of any real tracker's definition.
    // schema.json still validates against the real bundled one regardless
    // (see load.ts's defaultSchemaPath) - no volume override here either.
    const result = await buildProviderMap({
      configFile,
      cacheDir: path.join(dir, '.cache'),
      repoDefinitionsDir: path.join(ROOT, 'test', 'fixtures', 'cardigann')
    });

    assert.deepEqual(Object.keys(result), ['faketracker']);
    assert.equal(result.faketracker.name, 'Fake Tracker (test fixture)');
    assert.equal(result.faketracker.keepAlive?.url, 'https://faketracker.example/');
    assert.ok(result.faketracker.categories.includes(2000), 'Movies (2000) must be in the advertised categories');
  }));
