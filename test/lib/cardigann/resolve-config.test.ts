import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { resolveIndexerConfig } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'resolve-config.js'));

const DEF_YAML = `
id: thepiratebay
name: The Pirate Bay
description: "test"
language: en-US
type: public
encoding: UTF-8
links:
  - https://thepiratebay.org/
caps:
  categorymappings:
    - {id: 1, cat: Movies, desc: "Movies"}
  modes:
    search: [q]
settings:
  - name: top100
    type: select
    label: Top100
    default: recent
    options:
      recent: All
      "100": Audio
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

// A definition that fails the capability gate (has a login block) -
// exercises the "resolved fine, but capability-blocked" path distinctly
// from "couldn't resolve at all".
const PRIVATE_DEF_YAML = DEF_YAML.replace('id: thepiratebay', 'id: privatesite').replace(
  'settings:',
  'login:\n  method: post\n  path: login.php\nsettings:'
);

function withRepoDir(fn: (repo: string) => Promise<void>): Promise<void> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cardigann-resolveconfig-test-'));
  fs.writeFileSync(path.join(repo, 'thepiratebay.yml'), DEF_YAML);
  fs.writeFileSync(path.join(repo, 'privatesite.yml'), PRIVATE_DEF_YAML);
  return fn(repo).finally(() => fs.rmSync(repo, { recursive: true, force: true }));
}

test('resolveIndexerConfig: a fully valid config resolves every indexer', () =>
  withRepoDir(async (repo) => {
    const config = {
      indexers: {
        tpb: { definition: 'thepiratebay', config: { top100: '100' } },
        'tpb-2': { definition: 'thepiratebay' }
      }
    };

    const { ok, errors } = await resolveIndexerConfig(config, { repoDefinitionsDir: repo, cacheDir: path.join(repo, '.cache') });

    assert.equal(errors.length, 0);
    assert.equal(ok.length, 2);
    assert.equal(ok.find((r: { key: string }) => r.key === 'tpb')?.resolved.definitionId, 'thepiratebay');
  }));

test('resolveIndexerConfig: two instances of the same definition are independently resolved (not deduped/shared)', () =>
  withRepoDir(async (repo) => {
    const config = {
      indexers: {
        tpb: { definition: 'thepiratebay', config: { top100: 'recent' } },
        'tpb-audio': { definition: 'thepiratebay', config: { top100: '100' } }
      }
    };

    const { ok } = await resolveIndexerConfig(config, { repoDefinitionsDir: repo, cacheDir: path.join(repo, '.cache') });

    assert.equal(ok.length, 2);
    assert.equal(ok.find((r: { key: string }) => r.key === 'tpb')?.entry.config?.top100, 'recent');
    assert.equal(ok.find((r: { key: string }) => r.key === 'tpb-audio')?.entry.config?.top100, '100');
  }));

test('resolveIndexerConfig: a definition that fails the capability gate lands in errors, not ok', () =>
  withRepoDir(async (repo) => {
    const config = { indexers: { priv: { definition: 'privatesite' } } };

    const { ok, errors } = await resolveIndexerConfig(config, { repoDefinitionsDir: repo, cacheDir: path.join(repo, '.cache') });

    assert.equal(ok.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].reasons[0], /login\.method/);
  }));

test('resolveIndexerConfig: an unresolvable definition (not found anywhere) lands in errors, not a thrown exception', () =>
  withRepoDir(async (repo) => {
    const config = { indexers: { ghost: { definition: 'does-not-exist' } } };

    const { ok, errors } = await resolveIndexerConfig(config, { repoDefinitionsDir: repo, cacheDir: path.join(repo, '.cache') });

    assert.equal(ok.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].reasons[0], /not found/);
  }));

test('resolveIndexerConfig: one bad indexer does not stop the others from resolving', () =>
  withRepoDir(async (repo) => {
    const config = {
      indexers: {
        good: { definition: 'thepiratebay' },
        ghost: { definition: 'does-not-exist' }
      }
    };

    const { ok, errors } = await resolveIndexerConfig(config, { repoDefinitionsDir: repo, cacheDir: path.join(repo, '.cache') });

    assert.equal(ok.length, 1);
    assert.equal(ok[0].key, 'good');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].key, 'ghost');
  }));
