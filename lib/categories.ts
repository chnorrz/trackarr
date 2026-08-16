// Shared Torznab category ids. Providers map their own site-specific
// category schemes onto these.
export const CATEGORIES = {
  MOVIES: 2000,
  TV: 5000,
  TV_ANIME: 5070,
  AUDIO: 3000,
  PC: 4000,
  XXX: 6000,
  BOOKS: 7000,
  OTHER: 8000
} as const;

export const CATEGORIES_XML = `    <category id="2000" name="Movies" />
    <category id="5000" name="TV" />
    <category id="5070" name="TV/Anime" />
    <category id="3000" name="Audio" />
    <category id="4000" name="PC" />
    <category id="6000" name="XXX" />
    <category id="7000" name="Books" />
    <category id="8000" name="Other" />`;

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
