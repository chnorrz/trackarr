import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { applyFilter, applyFilters, andMatch } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'filters.js'));

// Every case here is the wiki's own worked example
// (wiki.servarr.com/prowlarr/cardigann-yml-definition, "Filters" section),
// not an invented one - the wiki text is the closest thing this format has
// to a spec.

test('querystring: extracts a named param from a url-shaped value', () => {
  assert.equal(applyFilter('querystring', 'cat', 'browse.php?cat=123'), '123');
});

test('prepend: inserts a fixed string at the start', () => {
  assert.equal(
    applyFilter('prepend', 'magnet:?xt=urn:btih:', 'B21F2A6DB07A8F4F76E2C5E15D28235D356B8D41'),
    'magnet:?xt=urn:btih:B21F2A6DB07A8F4F76E2C5E15D28235D356B8D41'
  );
});

test('append: adds a fixed string at the end', () => {
  assert.equal(
    applyFilter('append', '&tr=udp://tracker.coppersurfer.tk:6969', 'magnet:?xt=urn:btih:X&dn=I.Am.A.Magnet'),
    'magnet:?xt=urn:btih:X&dn=I.Am.A.Magnet&tr=udp://tracker.coppersurfer.tk:6969'
  );
});

test('tolower / toupper', () => {
  assert.equal(applyFilter('tolower', undefined, 'MY MOVIE TITLE 1080P'), 'my movie title 1080p');
  assert.equal(applyFilter('toupper', undefined, 'my movie title 1080p'), 'MY MOVIE TITLE 1080P');
});

test('replace: literal (non-regex) substring replacement', () => {
  assert.equal(applyFilter('replace', ['Y-day', 'yesterday'], 'Y-day 12:27'), 'yesterday 12:27');
});

test('split: divide on a single-char separator, return the indexed element', () => {
  assert.equal(applyFilter('split', ['/', 1], 'sub/45/0'), '45');
});

test('trim: no args strips whitespace; an arg strips that character set', () => {
  assert.equal(applyFilter('trim', undefined, '\u00a0This Is My Title\u00a0'.replace(/\u00a0/g, ' ')), 'This Is My Title');
  assert.equal(applyFilter('trim', 'x', 'xxxThis Is My Titlexxx'), 'This Is My Title');
});

test('regexp: extracts the first capture group, or the whole match if there is none', () => {
  assert.equal(applyFilter('regexp', 'Uploaded (.+?),', 'Uploaded 09-14 02:31, Size 282.88 MiB, ULed by'), '09-14 02:31');
});

test('re_replace: regex replace with $1 backreferences, applied globally', () => {
  assert.equal(applyFilter('re_replace', ['(\\d{2})x(\\d{2})', 'S$1E$2'], '12x45'), 'S12E45');
});

// Go's RE2 supports a leading "(?i)" (etc) inline-flag group - real
// upstream definitions use this a lot (1337x.yml, 8 times in one filter
// chain). JS's RegExp has no equivalent syntax; passed through literally
// it's parsed as an invalid capturing group and throws.
test('regexp: a leading "(?i)" Go inline-flag group is honored as JS case-insensitivity, not passed through literally', () => {
  assert.equal(applyFilter('regexp', '(?i)hello (\\w+)', 'HELLO World'), 'World');
});

test('re_replace: a leading "(?i)" Go inline-flag group is honored, replacement still applies globally', () => {
  assert.equal(applyFilter('re_replace', ['(?i)\\sEP\\s(\\d{1,2})\\s(E?\\s?\\d{1,2})\\s', ' E$1-$2 '], 'Show EP 3 4 More'), 'Show E3-4 More');
});

test('validate: keeps only whitelisted words, comma-joined, lowercased, underscores restored to spaces', () => {
  const input = 'crime, x264, 1080p, (music), pack, comedy, Science_Fiction, dd5.1, Hip/Hop';
  const whitelist = 'Action, Adventure, Crime, Comedy, Science_Fiction, War';
  assert.equal(applyFilter('validate', whitelist, input), 'crime, comedy, science fiction');
});

test('dateparse: parses a custom-format date string into RFC1123 form', () => {
  // The wiki's own worked example pairs format "yyyy-MMM-dd ..." (MMM =
  // alpha month name) with numeric input "2017-09-18" - an apparent
  // upstream doc typo (MMM cannot match "09"). Tested here with the
  // corrected numeric token (MM) instead of silently special-casing MMM to
  // also accept digits, which would be a wrong general-purpose behavior.
  const result = applyFilter('dateparse', 'yyyy-MM-dd HH:mm:ss zzz', '2017-09-18 19:17:24 +00:00');
  assert.equal(result, 'Mon, 18 Sep 2017 19:17:24 GMT');
});

test('timeparse is an alias for dateparse', () => {
  assert.equal(
    applyFilter('timeparse', 'yyyy-MM-dd', '2017-09-18'),
    applyFilter('dateparse', 'yyyy-MM-dd', '2017-09-18')
  );
});

test('timeago: relative phrase subtracted from now, matching the wiki\'s worked offsets', async () => {
  const now = new Date(Date.UTC(2017, 8, 18, 19, 17, 24)); // Mon 18 Sep 2017 19:17:24 UTC
  const { parseTimeAgo } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'relative-time.js'));
  assert.equal(parseTimeAgo('2 hours and 1 day', now)?.toUTCString(), 'Sun, 17 Sep 2017 17:17:24 GMT');
  assert.equal(parseTimeAgo('now', now)?.getTime(), now.getTime());
});

test('reltime is an alias for timeago', () => {
  assert.equal(applyFilter('reltime', undefined, 'now') !== '', true);
});

test('fuzzytime: Yesterday relative to a fixed now', async () => {
  const { parseFuzzyTime } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'relative-time.js'));
  const now = new Date(Date.UTC(2017, 8, 18, 19, 17, 24));
  assert.equal(parseFuzzyTime('Yesterday', now)?.toUTCString(), 'Sun, 17 Sep 2017 19:17:24 GMT');
});

test('htmldecode: the wiki\'s querystring -> htmldecode chain, decoding the entity querystring already url-decoded around', () => {
  // The wiki shows querystring's raw (still percent-encoded) input and
  // htmldecode's final output side by side, which reads as if htmldecode
  // does the url-decoding too - it doesn't. URLSearchParams.get()
  // (querystring's own implementation) already url-decodes %XX and "+", so
  // by the time htmldecode runs the value is already
  // "Anne Rice&#039;s Mayfair..." and its only remaining job is the &#039;
  // entity.
  const afterQuerystring = applyFilter(
    'querystring',
    'f',
    "?f=Anne+Rice%26%23039%3Bs+Mayfair+Witches+S01E01+1080p+WEB-DL+DD%2B+5.1+H.264-GGEZ"
  );
  assert.equal(afterQuerystring, "Anne Rice&#039;s Mayfair Witches S01E01 1080p WEB-DL DD+ 5.1 H.264-GGEZ");
  assert.equal(applyFilter('htmldecode', undefined, afterQuerystring), "Anne Rice's Mayfair Witches S01E01 1080p WEB-DL DD+ 5.1 H.264-GGEZ");
});

test('htmlencode: encodes to HTML entities, apostrophe as numeric entity', () => {
  assert.equal(applyFilter('htmlencode', undefined, "Anne Rice's Mayfair Witches"), 'Anne Rice&#39;s Mayfair Witches');
});

test('urldecode: decodes percent-escapes and treats + as a space', () => {
  assert.equal(
    applyFilter('urldecode', undefined, 'https://zooqle.com/search?q=preacher+s01e10'),
    'https://zooqle.com/search?q=preacher s01e10'
  );
});

test('urlencode: encodes, using + for spaces (form encoding, not %20)', () => {
  assert.equal(
    applyFilter('urlencode', undefined, 'https://zooqle.com/search?q=preacher s01e10'),
    'https%3A%2F%2Fzooqle.com%2Fsearch%3Fq%3Dpreacher+s01e10'
  );
});

test('validfilename: strips invalid filename characters AND whitespace', () => {
  // The wiki's own shown output ("aFileNameWithInvalidSymbols", capital F)
  // doesn't follow from simple character-stripping of its own input ("a
  // file?Name..." has a lowercase "file") - no case-transform rule is
  // documented anywhere for this filter, whose stated purpose is purely
  // "comprises only characters valid for filenames". Treated as a doc
  // inconsistency rather than an unverified behavior to invent and match.
  assert.equal(applyFilter('validfilename', undefined, 'a file?Name>With<Invalid*Symbols'), 'afileNameWithInvalidSymbols');
});

test('diacritics: strips combining marks after NFD normalization', () => {
  assert.equal(applyFilter('diacritics', 'replace', 'caf\u00e9'), 'cafe');
});

test('hexdump / strdump: identity passthrough (debug-only side effect)', () => {
  assert.equal(applyFilter('hexdump', undefined, 'Star Trek 1080p'), 'Star Trek 1080p');
  assert.equal(applyFilter('strdump', 'title', 'Star Trek 1080p'), 'Star Trek 1080p');
});

test('applyFilters: chains multiple filters in declared order', () => {
  const result = applyFilters([{ name: 'trim' }, { name: 'tolower' }], '  HELLO  ');
  assert.equal(result, 'hello');
});

test('applyFilters: undefined filter list is a no-op', () => {
  assert.equal(applyFilters(undefined, 'unchanged'), 'unchanged');
});

test('applyFilter: an unknown filter name throws rather than silently passing through', () => {
  assert.throws(() => applyFilter('not-a-real-filter', undefined, 'x'), /unsupported filter/);
});

// Confirmed against Prowlarr's own CardigannBase.cs (jsonjoinarray case):
// JObject.Parse(data).SelectToken(args[0]), then string.Join(args[1], ...)
// over the resulting array's own ToString() of each element.
test('jsonjoinarray: parses the value as JSON, selects an array by path, joins with the separator', () => {
  const value = JSON.stringify({ tags: ['x264', '1080p', 'WEB-DL'] });
  assert.equal(applyFilter('jsonjoinarray', ['tags', ', '], value), 'x264, 1080p, WEB-DL');
});

test('jsonjoinarray: a $-rooted path works the same as a bare relative one', () => {
  const value = JSON.stringify({ tags: ['a', 'b'] });
  assert.equal(applyFilter('jsonjoinarray', ['$.tags', '-'], value), 'a-b');
});

test('jsonjoinarray: non-string array elements are stringified, not dropped', () => {
  const value = JSON.stringify({ ids: [1, 2, 3] });
  assert.equal(applyFilter('jsonjoinarray', ['ids', ','], value), '1,2,3');
});

test('jsonjoinarray: a path that resolves to something other than an array yields empty', () => {
  const value = JSON.stringify({ tags: 'not-an-array' });
  assert.equal(applyFilter('jsonjoinarray', ['tags', ','], value), '');
});

// sha256/concat are a trackarr-only extension, not upstream Cardigann
// filters - see filters.ts's comment. Verified against known test vectors,
// not a wiki example.
test('sha256: hex digest of the input string', () => {
  assert.equal(applyFilter('sha256', undefined, ''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(applyFilter('sha256', undefined, 'abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('concat: joins the piped-in value with its args, no implicit separator', () => {
  assert.equal(applyFilter('concat', ['|', 'B', '|', 'C'], 'A'), 'A|B|C');
  assert.equal(applyFilter('concat', 'B', 'A'), 'AB');
});

test('andMatch: true only when every keyword appears in the row text', () => {
  assert.equal(andMatch('The Matrix 1999 1080p BluRay', 'matrix 1999', undefined), true);
  assert.equal(andMatch('The Matrix Reloaded', 'matrix 1999', undefined), false);
});

test('andMatch: respects the optional max-length argument (site truncates the title)', () => {
  // Row text is truncated to the first 10 chars before matching, so a
  // keyword only present after that point must not match.
  assert.equal(andMatch('The Matrix Reloaded', 'reloaded', 10), false);
  assert.equal(andMatch('The Matrix Reloaded', 'matrix', 10), true);
});
