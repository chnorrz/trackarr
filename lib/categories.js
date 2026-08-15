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
};

export const CATEGORIES_XML = `    <category id="2000" name="Movies" />
    <category id="5000" name="TV" />
    <category id="5070" name="TV/Anime" />
    <category id="3000" name="Audio" />
    <category id="4000" name="PC" />
    <category id="6000" name="XXX" />
    <category id="7000" name="Books" />
    <category id="8000" name="Other" />`;
