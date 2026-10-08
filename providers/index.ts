import { cfFetch, registerDomainCookies } from '../lib/browser.js';
import { createCardigannProvider } from '../lib/cardigann/adapter.js';
import { loadConfig } from '../lib/cardigann/config.js';
import { resolveIndexerConfig } from '../lib/cardigann/resolve-config.js';
import type { Provider } from '../lib/types.js';

const REPO_DEFINITIONS_DIR = 'definitions';

export interface BuildProviderMapOptions {
  /** Default: CONFIG_FILE env var, or 'config/trackarr.yml'. */
  configFile?: string;
  /** Default: DEFINITIONS_DIR env var (unset = no volume override). */
  definitionsDir?: string;
  /** Default: CARDIGANN_CACHE_DIR env var, or '.cardigann-cache'. */
  cacheDir?: string;
  /** Default: REPO_DEFINITIONS_DIR ('definitions'). Test-only override so the
   * bundled-fallback path can be exercised against a fixture dir instead of
   * the real definitions/ - schema.json is still validated from the real one
   * regardless (see load.ts's defaultSchemaPath). */
  repoDefinitionsDir?: string;
}

// Every indexer is Cardigann-driven now, entirely config-declared - no
// hardcoded providers, no built-in ids. Routes come from config/trackarr.yml
// alone: no config (or an empty indexers: block) means no routes at all,
// not a fallback set. Cardigann resolution needs real network fetches for
// any source:-declared indexer, so this can't run at synchronous
// module-load time - server.ts's boot sequence awaits this once, before
// listen(). A present-but-invalid config file throws here and is left to
// propagate (refuse to boot, per NOTES.md section 17: a broken config file
// is something the operator just edited and should see immediately). A
// single indexer failing its capability/cross-checks, or its own
// definition fetch failing with no fallback, is logged and simply excluded
// - the rest of the config still boots.
//
// Options default from env vars rather than reading them directly, so tests
// can point at a fixture config without env/module-cache workarounds; the
// real boot call site (server.ts) calls this with no arguments.
export async function buildProviderMap(opts: BuildProviderMapOptions = {}): Promise<Record<string, Provider>> {
  const configFile = opts.configFile ?? process.env.CONFIG_FILE ?? 'config/trackarr.yml';
  const definitionsDir = opts.definitionsDir ?? process.env.DEFINITIONS_DIR;
  const cacheDir = opts.cacheDir ?? process.env.CARDIGANN_CACHE_DIR ?? '.cardigann-cache';

  const config = loadConfig(configFile);
  if (!config) return {};

  const { ok, errors } = await resolveIndexerConfig(config, {
    repoDefinitionsDir: opts.repoDefinitionsDir ?? REPO_DEFINITIONS_DIR,
    volumeDefinitionsDir: definitionsDir,
    cacheDir
  });

  for (const e of errors) {
    console.error(`[cardigann] "${e.key}" not loaded: ${e.reasons.join('; ')}`);
  }

  // lib/cardigann's Fetcher is structurally identical to cfFetch's own
  // CfResponse-returning signature - passed straight through, no adapter
  // needed (cfFetch auto-detects a page vs. a raw file itself; see
  // lib/browser.ts's navigateOrDownload).
  const cardigannProviders = ok.map((indexer) => createCardigannProvider(indexer, { fetch: cfFetch }));
  for (const p of cardigannProviders) {
    // Always empty today - login blocks (the only source of cookies in the
    // Cardigann format) are excluded by the capability gate. Kept for when
    // that changes rather than assuming it never will.
    if (p.cookies?.length) registerDomainCookies(p.cookies);
  }

  return Object.fromEntries(cardigannProviders.map((p) => [p.id, p]));
}
