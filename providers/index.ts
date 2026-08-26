import extTo from './ext-to.js';
import x1337 from './1337x.js';
import eztv from './eztv.js';
import { cfFetch, downloadFile, registerDomainCookies } from '../lib/browser.js';
import { createCardigannProvider } from '../lib/cardigann/adapter.js';
import { loadConfig } from '../lib/cardigann/config.js';
import { resolveIndexerConfig } from '../lib/cardigann/resolve-config.js';
import type { Provider } from '../lib/types.js';

const providers: Provider[] = [extTo, x1337, eztv];

for (const p of providers) {
  if (p.cookies?.length) registerDomainCookies(p.cookies);
}

export const providerMap: Record<string, Provider> = Object.fromEntries(providers.map((p) => [p.id, p]));

const REPO_DEFINITIONS_DIR = 'definitions';

export interface BuildProviderMapOptions {
  /** Default: CONFIG_FILE env var, or 'config/trackarr.yml'. */
  configFile?: string;
  /** Default: DEFINITIONS_DIR env var (unset = no volume override). */
  definitionsDir?: string;
  /** Default: CARDIGANN_CACHE_DIR env var, or '.cardigann-cache'. */
  cacheDir?: string;
}

// Cardigann resolution needs real network fetches for any source:-declared
// indexer, so unlike providerMap above it can't run at synchronous
// module-load time - server.ts's boot sequence awaits this once, before
// listen(). A present-but-invalid config file throws here and is left to
// propagate (refuse to boot, per NOTES.md section 18: a broken config file
// is something the operator just edited and should see immediately). A
// single indexer failing its capability/cross-checks, or its own
// definition fetch failing with no fallback, is logged and simply excluded
// - the rest of the config, and the hand-written providers, still boot.
//
// Options default from env vars rather than reading them directly, so tests
// can point at a fixture config without env/module-cache workarounds; the
// real boot call site (server.ts) calls this with no arguments.
export async function buildProviderMap(opts: BuildProviderMapOptions = {}): Promise<Record<string, Provider>> {
  const configFile = opts.configFile ?? process.env.CONFIG_FILE ?? 'config/trackarr.yml';
  const definitionsDir = opts.definitionsDir ?? process.env.DEFINITIONS_DIR;
  const cacheDir = opts.cacheDir ?? process.env.CARDIGANN_CACHE_DIR ?? '.cardigann-cache';

  const config = loadConfig(configFile);
  if (!config) return providerMap;

  const reservedIds = new Set(Object.keys(providerMap));
  const { ok, errors } = await resolveIndexerConfig(
    config,
    { repoDefinitionsDir: REPO_DEFINITIONS_DIR, volumeDefinitionsDir: definitionsDir, cacheDir },
    reservedIds
  );

  for (const e of errors) {
    console.error(`[cardigann] "${e.key}" not loaded: ${e.reasons.join('; ')}`);
  }

  // lib/cardigann/*'s Fetcher/BinaryFetcher stay plain string/Buffer-
  // returning functions (dozens of call sites, unaffected by cfFetch's own
  // Response-shaped API) - adapted from cfFetch's CfResponse at this one
  // integration point instead.
  const cardigannProviders = ok.map((indexer) =>
    createCardigannProvider(indexer, {
      fetch: (url, opts) => cfFetch(url, opts).then((r) => r.text()),
      fetchBinary: downloadFile
    })
  );
  for (const p of cardigannProviders) {
    // Always empty today - login blocks (the only source of cookies in the
    // Cardigann format) are excluded by the capability gate. Kept for when
    // that changes rather than assuming it never will.
    if (p.cookies?.length) registerDomainCookies(p.cookies);
  }

  return { ...providerMap, ...Object.fromEntries(cardigannProviders.map((p) => [p.id, p])) };
}
