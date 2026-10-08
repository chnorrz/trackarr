// caps.json's Caps schema allows two alternative shapes for mapping a
// tracker's own category ids to our standard vocabulary - schema.json's
// `oneOf: [{required:[categories]}, {required:[categorymappings]}]`:
//   - categorymappings: [{id, cat, desc?}]  (array form, richer - allows a desc)
//   - categories: {"<trackerId>": "<StandardName>"}  (object form, simpler)
// Both are normalized into one shape here so engine.ts (forward: trackerId ->
// name, for parsing results) and the adapter (reverse: our numeric id ->
// trackerId[], for building .Categories on a request) share one reading of
// the definition instead of two independent, potentially-divergent ones.

export interface CategoryMappingEntry {
  trackerId: string;
  standardName: string;
  desc?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export function collectCategoryMappings(definition: Record<string, unknown>): CategoryMappingEntry[] {
  const caps = asRecord(definition.caps);
  const entries: CategoryMappingEntry[] = [];

  if (Array.isArray(caps.categorymappings)) {
    for (const m of caps.categorymappings as Record<string, unknown>[]) {
      entries.push({
        trackerId: String(m.id),
        standardName: String(m.cat),
        desc: typeof m.desc === 'string' ? m.desc : undefined
      });
    }
  }

  if (caps.categories !== null && typeof caps.categories === 'object' && !Array.isArray(caps.categories)) {
    for (const [trackerId, name] of Object.entries(caps.categories as Record<string, unknown>)) {
      entries.push({ trackerId, standardName: String(name) });
    }
  }

  return entries;
}
