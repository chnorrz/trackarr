#!/usr/bin/env node
// Standalone report, not imported by server.ts. Usage:
//   node dist/lib/cardigann/config-cli.js [path]
// Defaults to CONFIG_FILE or config/trackarr.yml. Loads the config, resolves
// every indexer's definition (fetching+caching for any with a `source:`),
// and runs both the capability gate and the config/definition cross-checks -
// the same steps phase 3's server.ts boot sequence will run to decide
// refuse-to-boot, surfaced here for local iteration on a config file before
// wiring it into anything that runs a browser.
import path from 'node:path';
import { loadConfig } from './config.js';
import { resolveIndexerConfig } from './resolve-config.js';

const configPath = path.resolve(process.argv[2] || process.env.CONFIG_FILE || 'config/trackarr.yml');

const config = loadConfig(configPath);

if (!config) {
  console.log(`No config file at ${configPath} - no Cardigann indexers configured.`);
  process.exit(0);
}

const indexerCount = Object.keys(config.indexers).length;
console.log(`Config: ${configPath}`);
console.log(`Indexers declared: ${indexerCount}`);

const { ok, errors } = await resolveIndexerConfig(config, {
  repoDefinitionsDir: path.resolve('definitions'),
  volumeDefinitionsDir: process.env.DEFINITIONS_DIR,
  cacheDir: process.env.CARDIGANN_CACHE_DIR || path.resolve('.cardigann-cache')
});

console.log(`  Resolved and runnable: ${ok.length}`);
console.log(`  Failed: ${errors.length}`);

if (ok.length > 0) {
  console.log('\n--- Resolved ---');
  for (const { key, resolved } of ok) {
    console.log(`  ${key}: ${resolved.definitionId} (${resolved.from})${resolved.portable ? '' : ' [trackarr-only]'}`);
  }
}

if (errors.length > 0) {
  console.log('\n--- Failed ---');
  for (const { key, reasons } of errors) {
    console.log(`  ${key}:`);
    for (const r of reasons) console.log(`    ${r}`);
  }
  process.exitCode = 1;
}
