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

// The full Newznab/Torznab standard vocabulary, verified against Prowlarr's
// own NewznabStandardCategory.cs (not guessed) and cross-checked against
// lib/cardigann/schema.json's IndexerCategories enum, which is the set of
// names a Cardigann definition's caps.categorymappings[].cat is allowed to
// use - 71 entries. Two ids in Prowlarr's own source (2090 Movies/x265, 5090
// TV/x265) are deliberately omitted: they don't appear in the vendored
// schema's enum, so no definition we accept can ever reference them.
const CATEGORY_DEFS: CategoryDef[] = [
  { id: 1000, name: 'Console' },
  { id: 1010, name: 'Console/NDS', parent: 1000 },
  { id: 1020, name: 'Console/PSP', parent: 1000 },
  { id: 1030, name: 'Console/Wii', parent: 1000 },
  { id: 1040, name: 'Console/XBox', parent: 1000 },
  { id: 1050, name: 'Console/XBox 360', parent: 1000 },
  { id: 1060, name: 'Console/Wiiware', parent: 1000 },
  { id: 1070, name: 'Console/XBox 360 DLC', parent: 1000 },
  { id: 1080, name: 'Console/PS3', parent: 1000 },
  { id: 1090, name: 'Console/Other', parent: 1000 },
  { id: 1110, name: 'Console/3DS', parent: 1000 },
  { id: 1120, name: 'Console/PS Vita', parent: 1000 },
  { id: 1130, name: 'Console/WiiU', parent: 1000 },
  { id: 1140, name: 'Console/XBox One', parent: 1000 },
  { id: 1180, name: 'Console/PS4', parent: 1000 },

  { id: 2000, name: 'Movies' },
  { id: 2010, name: 'Movies/Foreign', parent: 2000 },
  { id: 2020, name: 'Movies/Other', parent: 2000 },
  { id: 2030, name: 'Movies/SD', parent: 2000 },
  { id: 2040, name: 'Movies/HD', parent: 2000 },
  { id: 2045, name: 'Movies/UHD', parent: 2000 },
  { id: 2050, name: 'Movies/BluRay', parent: 2000 },
  { id: 2060, name: 'Movies/3D', parent: 2000 },
  { id: 2070, name: 'Movies/DVD', parent: 2000 },
  { id: 2080, name: 'Movies/WEB-DL', parent: 2000 },

  { id: 3000, name: 'Audio' },
  { id: 3010, name: 'Audio/MP3', parent: 3000 },
  { id: 3020, name: 'Audio/Video', parent: 3000 },
  { id: 3030, name: 'Audio/Audiobook', parent: 3000 },
  { id: 3040, name: 'Audio/Lossless', parent: 3000 },
  { id: 3050, name: 'Audio/Other', parent: 3000 },
  { id: 3060, name: 'Audio/Foreign', parent: 3000 },

  { id: 4000, name: 'PC' },
  { id: 4010, name: 'PC/0day', parent: 4000 },
  { id: 4020, name: 'PC/ISO', parent: 4000 },
  { id: 4030, name: 'PC/Mac', parent: 4000 },
  { id: 4040, name: 'PC/Mobile-Other', parent: 4000 },
  { id: 4050, name: 'PC/Games', parent: 4000 },
  { id: 4060, name: 'PC/Mobile-iOS', parent: 4000 },
  { id: 4070, name: 'PC/Mobile-Android', parent: 4000 },

  { id: 5000, name: 'TV' },
  { id: 5010, name: 'TV/WEB-DL', parent: 5000 },
  { id: 5020, name: 'TV/Foreign', parent: 5000 },
  { id: 5030, name: 'TV/SD', parent: 5000 },
  { id: 5040, name: 'TV/HD', parent: 5000 },
  { id: 5045, name: 'TV/UHD', parent: 5000 },
  { id: 5050, name: 'TV/Other', parent: 5000 },
  { id: 5060, name: 'TV/Sport', parent: 5000 },
  { id: 5070, name: 'TV/Anime', parent: 5000 },
  { id: 5080, name: 'TV/Documentary', parent: 5000 },

  { id: 6000, name: 'XXX' },
  { id: 6010, name: 'XXX/DVD', parent: 6000 },
  { id: 6020, name: 'XXX/WMV', parent: 6000 },
  { id: 6030, name: 'XXX/XviD', parent: 6000 },
  { id: 6040, name: 'XXX/x264', parent: 6000 },
  { id: 6045, name: 'XXX/UHD', parent: 6000 },
  { id: 6050, name: 'XXX/Pack', parent: 6000 },
  { id: 6060, name: 'XXX/ImageSet', parent: 6000 },
  { id: 6070, name: 'XXX/Other', parent: 6000 },
  { id: 6080, name: 'XXX/SD', parent: 6000 },
  { id: 6090, name: 'XXX/WEB-DL', parent: 6000 },

  { id: 7000, name: 'Books' },
  { id: 7010, name: 'Books/Mags', parent: 7000 },
  { id: 7020, name: 'Books/EBook', parent: 7000 },
  { id: 7030, name: 'Books/Comics', parent: 7000 },
  { id: 7040, name: 'Books/Technical', parent: 7000 },
  { id: 7050, name: 'Books/Other', parent: 7000 },
  { id: 7060, name: 'Books/Foreign', parent: 7000 },

  { id: 8000, name: 'Other' },
  { id: 8010, name: 'Other/Misc', parent: 8000 },
  { id: 8020, name: 'Other/Hashed', parent: 8000 }
];

const NAME_TO_ID = new Map(CATEGORY_DEFS.map((d) => [d.name, d.id]));
const ID_TO_NAME = new Map(CATEGORY_DEFS.map((d) => [d.id, d.name]));

/** Standard category name (e.g. "TV/Anime") -> numeric Torznab id. Falls
 * back to CATEGORIES.OTHER for a name outside the 71-entry vocabulary,
 * e.g. a Cardigann definition whose categorymappings names an "Other/..."
 * variant our schema doesn't enumerate. */
export function categoryIdByName(name: string): number {
  return NAME_TO_ID.get(name) ?? CATEGORIES.OTHER;
}

/** Numeric Torznab id -> standard category name, if it's one of the 71. */
export function categoryNameById(id: number): string | undefined {
  return ID_TO_NAME.get(id);
}

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
