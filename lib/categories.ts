// Shared Torznab category ids. Providers map their own site-specific
// category schemes onto these. Ids beyond the original flat set match the
// real Newznab/Torznab standard (confirmed against Prowlarr's own
// NewznabStandardCategory.cs) rather than being invented - added because a
// real downstream consumer needs the distinction: Bindery (ebook/audiobook
// managers) requires 7020/3030 specifically, bare 7000/3000 aren't enough
// (see NOTES.md). 4050 and the 1000-series console ids were added for the
// same reason, once ext.to/1337x's own category schemes turned out to
// support that granularity.
export const CATEGORIES = {
  MOVIES: 2000,
  TV: 5000,
  TV_ANIME: 5070,
  AUDIO: 3000,
  AUDIOBOOKS: 3030,
  PC: 4000,
  PC_MAC: 4030,
  PC_GAMES: 4050,
  PC_MOBILE_IOS: 4060,
  PC_MOBILE_ANDROID: 4070,
  XXX: 6000,
  BOOKS: 7000,
  BOOKS_EBOOK: 7020,
  OTHER: 8000,
  // Console (1000-series) is its own parent tree, separate from PC/4000 -
  // only the ids actually reachable via ext.to's/1337x's own category
  // schemes are listed; anything else (older/newer consoles the standard
  // doesn't have a dedicated id for) falls back to CONSOLE_OTHER.
  CONSOLE_NDS: 1010,
  CONSOLE_PSP: 1020,
  CONSOLE_WII: 1030,
  CONSOLE_XBOX: 1040,
  CONSOLE_XBOX360: 1050,
  CONSOLE_PS3: 1080,
  CONSOLE_OTHER: 1090,
  CONSOLE_3DS: 1110,
  CONSOLE_PS4: 1180
} as const;

interface CategoryDef {
  id: number;
  name: string;
  /** Set for every subcat - the Newznab/Torznab standard convention nests an
   * Xnnn id under its X000 parent (e.g. 5070 TV/Anime under 5000 TV). */
  parent?: number;
}

const CATEGORY_DEFS: CategoryDef[] = [
  { id: 2000, name: 'Movies' },
  { id: 5000, name: 'TV' },
  { id: 5070, name: 'TV/Anime', parent: 5000 },
  { id: 3000, name: 'Audio' },
  { id: 3030, name: 'Audio/Audiobook', parent: 3000 },
  { id: 4000, name: 'PC' },
  { id: 4030, name: 'PC/Mac', parent: 4000 },
  { id: 4050, name: 'PC/Games', parent: 4000 },
  { id: 4060, name: 'PC/Mobile-iOS', parent: 4000 },
  { id: 4070, name: 'PC/Mobile-Android', parent: 4000 },
  { id: 6000, name: 'XXX' },
  { id: 7000, name: 'Books' },
  { id: 7020, name: 'Books/EBook', parent: 7000 },
  { id: 8000, name: 'Other' },
  { id: 1000, name: 'Console' },
  { id: 1010, name: 'Console/NDS', parent: 1000 },
  { id: 1020, name: 'Console/PSP', parent: 1000 },
  { id: 1030, name: 'Console/Wii', parent: 1000 },
  { id: 1040, name: 'Console/XBox', parent: 1000 },
  { id: 1050, name: 'Console/XBox 360', parent: 1000 },
  { id: 1080, name: 'Console/PS3', parent: 1000 },
  { id: 1090, name: 'Console/Other', parent: 1000 },
  { id: 1110, name: 'Console/3DS', parent: 1000 },
  { id: 1180, name: 'Console/PS4', parent: 1000 }
];

/**
 * Renders a <categories> block containing only the ids a given provider
 * actually offers - e.g. EZTV is TV-only, so it should never advertise
 * Movies/Books/XXX/etc just because trackarr-wide CATEGORIES has them.
 * A subcat pulls its parent in automatically (Torznab caps nest subcats
 * under a parent category element) even if the provider only listed the
 * subcat id; a lone id with no parent/children renders as a self-closing
 * <category />.
 */
export function categoriesXml(ids: number[]): string {
  const idSet = new Set(ids);
  const parentIds = new Set(CATEGORY_DEFS.filter((d) => d.parent && idSet.has(d.id)).map((d) => d.parent as number));

  return CATEGORY_DEFS.filter((d) => !d.parent && (idSet.has(d.id) || parentIds.has(d.id)))
    .map((top) => {
      const children = CATEGORY_DEFS.filter((d) => d.parent === top.id && idSet.has(d.id));
      if (!children.length) return `    <category id="${top.id}" name="${top.name}" />`;
      const subcats = children.map((c) => `      <subcat id="${c.id}" name="${c.name}" />`).join('\n');
      return `    <category id="${top.id}" name="${top.name}">\n${subcats}\n    </category>`;
    })
    .join('\n');
}

/** An ordered [keywords, category] rule for matchCategory - first match wins. */
export type CategoryRule = [string[], number];

/**
 * Maps a provider-specific string to a Torznab category id.
 *
 * `rules` is an ordered list of [keywords, category] - the first rule with a
 * matching substring wins, so put the more specific ones first (e.g. "tv"
 * before "movie", or a title like "TV Movies" lands in the wrong bucket).
 *
 * The keyword tables stay in the providers because the input differs per
 * site: ext.to matches breadcrumb text, 1337x matches a CSS icon class. Only
 * the matching mechanism is shared.
 */
export function matchCategory(text: string | undefined | null, rules: CategoryRule[]): number {
  const haystack = (text || '').toLowerCase();
  for (const [keywords, category] of rules) {
    if (keywords.some((k) => haystack.includes(k))) return category;
  }
  return CATEGORIES.OTHER;
}
