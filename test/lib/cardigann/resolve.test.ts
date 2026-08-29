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

// A volume mount is a self-contained override directory (see resolve.ts):
// any test where the definition's origin is the volume dir needs its own
// schema.json alongside it, same as a real deployment would.
function giveVolumeItsOwnSchema(volume: string): void {
  fs.copyFileSync(path.join(ROOT, 'definitions', 'schema.json'), path.join(volume, 'schema.json'));
}

const REAL_SCHEMA = fs.readFileSync(path.join(ROOT, 'definitions', 'schema.json'), 'utf8');

// A source:-fetched definition now also fetches schema.json from that same
// source (resolve.ts's buildSchemaUrl) - any fetchImpl mock for a source:
// test needs to serve both URLs, not just the .yml's.

test('resolveDefinition: finds a definition in the bundled repo dir', () =>
  withTempDirs(async ({ repo, volume, cache }) => {
    fs.writeFileSync(path.join(repo, 'foo.yml'), minimalDefinitionYaml('foo'));

    const result = await resolveDefinition('foo', undefined, { repoDefinitionsDir: repo, volumeDefinitionsDir: volume, cacheDir: cache });
    assert.equal(result.definitionId, 'foo');
    assert.equal(result.from, path.join(repo, 'foo.yml'));
  }));

test('resolveDefinition: DEFINITIONS_DIR (volume) wins over the repo dir even with no source given', () =>
  withTempDirs(async ({ repo, volume, cache }) => {
    giveVolumeItsOwnSchema(volume);
    fs.writeFileSync(path.join(repo, 'foo.yml'), minimalDefinitionYaml('foo', 'Repo Version'));
    fs.writeFileSync(path.join(volume, 'foo.yml'), minimalDefinitionYaml('foo', 'Volume Override'));

    const result = await resolveDefinition('foo', undefined, { repoDefinitionsDir: repo, volumeDefinitionsDir: volume, cacheDir: cache });
    assert.equal(result.definition.name, 'Volume Override');
  }));

test('resolveDefinition: DEFINITIONS_DIR wins even over an explicit source (the override escape hatch)', () =>
  withTempDirs(async ({ repo, volume, cache }) => {
    giveVolumeItsOwnSchema(volume);
    fs.writeFileSync(path.join(volume, 'foo.yml'), minimalDefinitionYaml('foo', 'Volume Override'));
    const fetchImpl = async () => {
      throw new Error('fetch should never be called - the volume copy must win first');
    };

    const result = await resolveDefinition('foo', 'https://example.test/foo.yml', {
      repoDefinitionsDir: repo, volumeDefinitionsDir: volume, cacheDir: cache, fetchImpl: fetchImpl as unknown as typeof fetch
    });
    assert.equal(result.definition.name, 'Volume Override');
  }));

test('resolveDefinition: a volume mount without its own schema.json fails that definition, rather than silently falling back to the bundled schema', () =>
  withTempDirs(async ({ repo, volume, cache }) => {
    fs.writeFileSync(path.join(volume, 'foo.yml'), minimalDefinitionYaml('foo', 'Volume Override'));

    await assert.rejects(
      () => resolveDefinition('foo', undefined, { repoDefinitionsDir: repo, volumeDefinitionsDir: volume, cacheDir: cache }),
      /no schema\.json found/
    );
  }));

test('resolveDefinition: a source URL is fetched and cached to disk, schema.json included', () =>
  withTempDirs(async ({ repo, cache }) => {
    const urls: string[] = [];
    const fetchImpl = async (url: string | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.endsWith('/schema.json')) return new Response(REAL_SCHEMA, { status: 200 });
      return new Response(minimalDefinitionYaml('foo', 'Fetched'), { status: 200 });
    };

    const result = await resolveDefinition('foo', 'https://example.test/foo.yml', {
      repoDefinitionsDir: repo, cacheDir: cache, fetchImpl: fetchImpl as unknown as typeof fetch
    });

    assert.deepEqual(urls.sort(), ['https://example.test/foo.yml', 'https://example.test/schema.json'].sort());
    assert.equal(result.definition.name, 'Fetched');
    assert.ok(fs.existsSync(path.join(cache, 'foo.yml')));
    assert.ok(fs.existsSync(path.join(cache, 'foo.meta.json')));
    const schemaCacheFile = fs.readdirSync(cache).find((f) => f.startsWith('schema-') && f.endsWith('.json'));
    assert.ok(schemaCacheFile, 'schema.json must be cached to disk too, same as the .yml');
  }));

test('resolveDefinition: a pin shorthand builds the URL from pins.json, appending <id>.yml (and its own schema.json)', () =>
  withTempDirs(async ({ repo, cache }) => {
    const requestedUrls: string[] = [];
    const fetchImpl = async (url: string | URL) => {
      const u = String(url);
      requestedUrls.push(u);
      if (u.endsWith('/schema.json')) return new Response(REAL_SCHEMA, { status: 200 });
      return new Response(minimalDefinitionYaml('kickasstorrents-to'), { status: 200 });
    };

    await resolveDefinition('kickasstorrents-to', 'prowlarr:v11', {
      repoDefinitionsDir: repo, cacheDir: cache, fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const defUrl = requestedUrls.find((u) => u.endsWith('.yml'));
    const schemaUrl = requestedUrls.find((u) => u.endsWith('/schema.json'));
    assert.match(defUrl ?? '', /^https:\/\/raw\.githubusercontent\.com\/Prowlarr\/Indexers\/[a-f0-9]{40}\/definitions\/v11\/kickasstorrents-to\.yml$/);
    // Same directory as the .yml, same commit - never the bundled schema.
    assert.match(schemaUrl ?? '', /^https:\/\/raw\.githubusercontent\.com\/Prowlarr\/Indexers\/[a-f0-9]{40}\/definitions\/v11\/schema\.json$/);
  }));

test('resolveDefinition: a failed fetch falls back to a previously cached copy (offline restart), schema.json included', () =>
  withTempDirs(async ({ repo, cache }) => {
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'foo.yml'), minimalDefinitionYaml('foo', 'Stale Cache'));
    // Mirrors resolve.ts's own sanitizeForFilename() - a real offline
    // restart would have this cached from the last successful boot too.
    const source = 'https://example.test/foo.yml';
    const schemaCacheFile = path.join(cache, `schema-${source.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`);
    fs.writeFileSync(schemaCacheFile, REAL_SCHEMA);

    const fetchImpl = async () => {
      throw new Error('network down');
    };

    const result = await resolveDefinition('foo', source, {
      repoDefinitionsDir: repo, cacheDir: cache, fetchImpl: fetchImpl as unknown as typeof fetch
    });

    assert.equal(result.definition.name, 'Stale Cache');
    assert.match(result.from, /stale cache/);
  }));

test('resolveDefinition: schema.json fetch fails with no prior cache - fatal, same as the .yml\'s own fetch failing', () =>
  withTempDirs(async ({ repo, cache }) => {
    const fetchImpl = async (url: string | URL) => {
      if (String(url).endsWith('/schema.json')) throw new Error('schema fetch down');
      return new Response(minimalDefinitionYaml('foo', 'Fetched'), { status: 200 });
    };

    await assert.rejects(
      () => resolveDefinition('foo', 'https://example.test/foo.yml', {
        repoDefinitionsDir: repo, cacheDir: cache, fetchImpl: fetchImpl as unknown as typeof fetch
      }),
      /schema fetch down/
    );
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
