import { checkCapability } from './capability.js';
import type { IndexerConfigEntry, TrackarrConfig } from './config.js';
import { resolveDefinition, type ResolveOptions, type ResolvedDefinition } from './resolve.js';
import { validateIndexerConfig } from './validate-config.js';

export interface ResolvedIndexer {
  key: string;
  entry: IndexerConfigEntry;
  resolved: ResolvedDefinition;
}

export interface ConfigResolutionResult {
  ok: ResolvedIndexer[];
  errors: { key: string; reasons: string[] }[];
}

// Ties config.ts (the file), resolve.ts (finding + fetching each definition)
// and both validators together, collecting every problem across every
// indexer rather than stopping at the first - so a "refuse to boot" caller
// can report everything wrong in one pass instead of a fix-one-restart loop.
export async function resolveIndexerConfig(
  config: TrackarrConfig,
  opts: ResolveOptions,
  reservedIds: ReadonlySet<string>
): Promise<ConfigResolutionResult> {
  const ok: ResolvedIndexer[] = [];
  const errors: { key: string; reasons: string[] }[] = [];

  for (const [key, entry] of Object.entries(config.indexers)) {
    try {
      const resolved = await resolveDefinition(entry.definition, entry.source, opts);
      const reasons = [...checkCapability(resolved.definition), ...validateIndexerConfig(key, entry, resolved, reservedIds)];

      if (reasons.length > 0) errors.push({ key, reasons });
      else ok.push({ key, entry, resolved });
    } catch (err) {
      errors.push({ key, reasons: [err instanceof Error ? err.message : String(err)] });
    }
  }

  return { ok, errors };
}
