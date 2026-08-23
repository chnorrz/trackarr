// Subcat ids follow the real Newznab/Torznab standard because downstream
// consumers need them: Bindery requires 7020/3030, bare 7000/3000 won't do.
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

export type CategoryRule = [string[], number];

/** Rules are ordered and the first substring match wins, so more specific
 * keywords must come first ("tv" before "movie", or "TV Movies" mis-buckets). */
export function matchCategory(text: string | undefined | null, rules: CategoryRule[]): number {
  const haystack = (text || '').toLowerCase();
  for (const [keywords, category] of rules) {
    if (keywords.some((k) => haystack.includes(k))) return category;
  }
  return CATEGORIES.OTHER;
}
