import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { resolveDefinition } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'resolve.js'));

function minimalDefinitionYaml(id: string, name = 'Test'): string {
  return `
id: ${id}
name: ${name}
description: "test"
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
    - path: search
  rows:
    selector: tr
  fields:
    title: { selector: a }
    size: { text: "0 B" }
    seeders: { text: "0" }
    category: { text: "1" }
    download: { selector: a, attribute: href }
`;
}

function withTempDirs(fn: (dirs: { repo: string; volume: string; cache: string }) => Promise<void>): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cardigann-resolve-test-'));
  const dirs = {
    repo: path.join(base, 'repo'),
    volume: path.join(base, 'volume'),
    cache: path.join(base, 'cache')
  };
  fs.mkdirSync(dirs.repo);
  fs.mkdirSync(dirs.volume);

  return fn(dirs).finally(() => fs.rmSync(base, { recursive: true, force: true }));
}

test('resolveDefinition: finds a definition in the bundled repo dir', () =>
  withTempDirs(async ({ repo, volume, cache }) => {
    fs.writeFileSync(path.join(repo, 'foo.yml'), minimalDefinitionYaml('foo'));

    const result = await resolveDefinition('foo', undefined, { repoDefinitionsDir: repo, volumeDefinitionsDir: volume, cacheDir: cache });
    assert.equal(result.definitionId, 'foo');
    assert.equal(result.from, path.join(repo, 'foo.yml'));
  }));

test('resolveDefinition: DEFINITIONS_DIR (volume) wins over the repo dir even with no source given', () =>
  withTempDirs(async ({ repo, volume, cache }) => {
    fs.writeFileSync(path.join(repo, 'foo.yml'), minimalDefinitionYaml('foo', 'Repo Version'));
    fs.writeFileSync(path.join(volume, 'foo.yml'), minimalDefinitionYaml('foo', 'Volume Override'));

    const result = await resolveDefinition('foo', undefined, { repoDefinitionsDir: repo, volumeDefinitionsDir: volume, cacheDir: cache });
    assert.equal(result.definition.name, 'Volume Override');
  }));

test('resolveDefinition: DEFINITIONS_DIR wins even over an explicit source (the override escape hatch)', () =>
  withTempDirs(async ({ repo, volume, cache }) => {
    fs.writeFileSync(path.join(volume, 'foo.yml'), minimalDefinitionYaml('foo', 'Volume Override'));
    const fetchImpl = async () => {
      throw new Error('fetch should never be called - the volume copy must win first');
    };

    const result = await resolveDefinition('foo', 'https://example.test/foo.yml', {
      repoDefinitionsDir: repo, volumeDefinitionsDir: volume, cacheDir: cache, fetchImpl: fetchImpl as unknown as typeof fetch
    });
    assert.equal(result.definition.name, 'Volume Override');
  }));

test('resolveDefinition: a source URL is fetched and cached to disk', () =>
  withTempDirs(async ({ repo, cache }) => {
    let calls = 0;
    const fetchImpl = async (url: string | URL) => {
      calls++;
      assert.equal(String(url), 'https://example.test/foo.yml');
      return new Response(minimalDefinitionYaml('foo', 'Fetched'), { status: 200 });
    };

    const result = await resolveDefinition('foo', 'https://example.test/foo.yml', {
      repoDefinitionsDir: repo, cacheDir: cache, fetchImpl: fetchImpl as unknown as typeof fetch
    });

    assert.equal(calls, 1);
    assert.equal(result.definition.name, 'Fetched');
    assert.ok(fs.existsSync(path.join(cache, 'foo.yml')));
    assert.ok(fs.existsSync(path.join(cache, 'foo.meta.json')));
  }));

test('resolveDefinition: a pin shorthand builds the URL from pins.json, appending <id>.yml', () =>
  withTempDirs(async ({ repo, cache }) => {
    let requestedUrl = '';
    const fetchImpl = async (url: string | URL) => {
      requestedUrl = String(url);
      return new Response(minimalDefinitionYaml('kickasstorrents-to'), { status: 200 });
    };

    await resolveDefinition('kickasstorrents-to', 'prowlarr:v11', {
      repoDefinitionsDir: repo, cacheDir: cache, fetchImpl: fetchImpl as unknown as typeof fetch
    });

    assert.match(requestedUrl, /^https:\/\/raw\.githubusercontent\.com\/Prowlarr\/Indexers\/[a-f0-9]{40}\/definitions\/v11\/kickasstorrents-to\.yml$/);
  }));

test('resolveDefinition: a failed fetch falls back to a previously cached copy (offline restart)', () =>
  withTempDirs(async ({ repo, cache }) => {
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'foo.yml'), minimalDefinitionYaml('foo', 'Stale Cache'));

    const fetchImpl = async () => {
      throw new Error('network down');
    };

    const result = await resolveDefinition('foo', 'https://example.test/foo.yml', {
      repoDefinitionsDir: repo, cacheDir: cache, fetchImpl: fetchImpl as unknown as typeof fetch
    });

    assert.equal(result.definition.name, 'Stale Cache');
    assert.match(result.from, /stale cache/);
  }));

test('resolveDefinition: a failed fetch with no cache and no local copy throws', () =>
  withTempDirs(async ({ repo, cache }) => {
    const fetchImpl = async () => {
      throw new Error('network down');
    };

    await assert.rejects(
      () => resolveDefinition('foo', 'https://example.test/foo.yml', {
        repoDefinitionsDir: repo, cacheDir: cache, fetchImpl: fetchImpl as unknown as typeof fetch
      }),
      /network down/
    );
  }));

test('resolveDefinition: a definition whose declared id does not match the requested id is rejected', () =>
  withTempDirs(async ({ repo, cache }) => {
    // File is named wrong.yml but requested as "foo" - a copy/paste mistake.
    fs.writeFileSync(path.join(repo, 'foo.yml'), minimalDefinitionYaml('wrong-id'));

    await assert.rejects(
      () => resolveDefinition('foo', undefined, { repoDefinitionsDir: repo, cacheDir: cache }),
      /declares id "wrong-id", but was requested as "foo"/
    );
  }));

test('resolveDefinition: not found anywhere (no local file, no source) throws naming what was tried', () =>
  withTempDirs(async ({ repo, volume, cache }) => {
    await assert.rejects(
      () => resolveDefinition('nonexistent', undefined, { repoDefinitionsDir: repo, volumeDefinitionsDir: volume, cacheDir: cache }),
      /definition "nonexistent" not found/
    );
  }));

test('resolveDefinition: an unknown source string (not a URL, not a known pin) throws', () =>
  withTempDirs(async ({ repo, cache }) => {
    await assert.rejects(
      () => resolveDefinition('foo', 'not-a-real-source', { repoDefinitionsDir: repo, cacheDir: cache }),
      /unknown source/
    );
  }));
