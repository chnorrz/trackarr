import type { IndexerConfigEntry } from './config.js';
import type { ResolvedDefinition } from './resolve.js';

interface SettingsField {
  name: string;
  type: string;
  options?: Record<string, string>;
}

// Everything here is a thing the two JSON Schemas (config-schema.json,
// schema.json) can't express on their own, because it depends on *both*
// documents at once: a config key that isn't one of the definition's own
// settings, a select value outside that setting's declared options, a link
// not actually in the definition's links[], or an indexer name colliding
// with a built-in provider. All fatal - refuse to boot, same as a schema
// failure, since these are exactly the mistakes a schema can't catch but a
// human typo produces just as easily.
export function validateIndexerConfig(
  entryKey: string,
  entry: IndexerConfigEntry,
  resolved: ResolvedDefinition,
  reservedIds: ReadonlySet<string>
): string[] {
  const reasons: string[] = [];

  if (reservedIds.has(entryKey)) {
    reasons.push(`indexers.${entryKey}: id collides with a built-in provider - rename this indexer`);
  }

  const links = Array.isArray(resolved.definition.links) ? (resolved.definition.links as unknown[]) : [];
  if (entry.link !== undefined && !links.includes(entry.link)) {
    reasons.push(`indexers.${entryKey}.link: "${entry.link}" is not in ${resolved.definitionId}'s links[] (${links.join(', ') || 'none'})`);
  }

  const settingsList = Array.isArray(resolved.definition.settings) ? (resolved.definition.settings as SettingsField[]) : [];
  const settingsByName = new Map(settingsList.map((s) => [s.name, s]));

  for (const [key, value] of Object.entries(entry.config ?? {})) {
    const setting = settingsByName.get(key);
    if (!setting) {
      reasons.push(`indexers.${entryKey}.config.${key}: not a known setting of ${resolved.definitionId} (${[...settingsByName.keys()].join(', ') || 'this definition has no settings'})`);
      continue;
    }
    if (setting.type === 'select' && setting.options && !(String(value) in setting.options)) {
      reasons.push(`indexers.${entryKey}.config.${key}: "${value}" is not one of ${resolved.definitionId}'s options for this setting (${Object.keys(setting.options).join(', ')})`);
    }
  }

  return reasons;
}
