import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const { providerMap, buildProviderMap } = await import(path.join(ROOT, 'dist', 'providers', 'index.js'));

const BUILTIN_IDS = ['ext-to', '1337x', 'eztv'];

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

test('buildProviderMap() with no config file present returns exactly the 3 hand-written providers', () =>
  withScratch(async (dir) => {
    const result = await buildProviderMap({ configFile: path.join(dir, 'does-not-exist.yml') });
    assert.deepEqual(Object.keys(result).sort(), [...BUILTIN_IDS].sort());
    assert.equal(result, providerMap, 'must return the same providerMap instance, not a copy, when there is no config');
  }));

test('buildProviderMap() with a valid config adds a real Cardigann provider alongside the built-in ones', () =>
  withScratch(async (dir) => {
    fs.writeFileSync(path.join(dir, 'synth.yml'), SYNTH_DEF_YAML);
    const configFile = writeConfig(dir, 'indexers:\n  synth:\n    definition: synth\n');

    const result = await buildProviderMap({ configFile, definitionsDir: dir, cacheDir: path.join(dir, '.cache') });

    assert.deepEqual(Object.keys(result).sort(), [...BUILTIN_IDS, 'synth'].sort());
    assert.equal(result.synth.id, 'synth');
    assert.equal(result.synth.name, 'Synthetic Tracker');
    assert.deepEqual(result.synth.categories, [2000]);
    assert.equal(typeof result.synth.search, 'function');
    assert.equal(typeof result.synth.resolveMagnet, 'function');
    // The 3 hand-written providers are untouched, same objects as providerMap's own.
    for (const id of BUILTIN_IDS) assert.equal(result[id], providerMap[id]);
  }));

test('buildProviderMap() excludes an indexer whose key collides with a built-in provider id, without crashing', () =>
  withScratch(async (dir) => {
    fs.writeFileSync(path.join(dir, 'synth.yml'), SYNTH_DEF_YAML);
    const configFile = writeConfig(dir, 'indexers:\n  eztv:\n    definition: synth\n');

    const result = await buildProviderMap({ configFile, definitionsDir: dir, cacheDir: path.join(dir, '.cache') });

    assert.deepEqual(Object.keys(result).sort(), [...BUILTIN_IDS].sort());
    assert.equal(result.eztv, providerMap.eztv, 'the real built-in eztv provider must survive, not be replaced');
  }));

test('buildProviderMap() excludes one bad indexer entry but still boots the rest, hand-written and Cardigann alike', () =>
  withScratch(async (dir) => {
    fs.writeFileSync(path.join(dir, 'synth.yml'), SYNTH_DEF_YAML);
    const configFile = writeConfig(
      dir,
      'indexers:\n  synth:\n    definition: synth\n  broken:\n    definition: this-definition-does-not-exist\n'
    );

    const result = await buildProviderMap({ configFile, definitionsDir: dir, cacheDir: path.join(dir, '.cache') });

    assert.deepEqual(Object.keys(result).sort(), [...BUILTIN_IDS, 'synth'].sort());
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

test('buildProviderMap() end to end with the real, checked-in definitions/kickasstorrents-to.yml (bundled repo fallback, no volume override)', () =>
  withScratch(async (dir) => {
    const configFile = writeConfig(dir, 'indexers:\n  kickass:\n    definition: kickasstorrents-to\n');

    // No definitionsDir override here deliberately - this exercises the
    // real bundled-repo fallback path (REPO_DEFINITIONS_DIR = 'definitions',
    // resolved relative to CWD, same as the real boot sequence), the same
    // configuration verified live via a real server boot this session.
    const result = await buildProviderMap({ configFile, cacheDir: path.join(dir, '.cache') });

    assert.deepEqual(Object.keys(result).sort(), [...BUILTIN_IDS, 'kickass'].sort());
    assert.equal(result.kickass.name, 'kickasstorrents.to');
    assert.equal(result.kickass.keepAlive?.url, 'https://kickass.torrentbay.st/');
    assert.ok(result.kickass.categories.includes(2000), 'Movies (2000) must be in the advertised categories');
  }));
