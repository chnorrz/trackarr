import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { renderTemplate } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'template.js'));

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    Keywords: '',
    Query: {},
    Categories: [],
    Config: {},
    Result: {},
    ...overrides
  };
}

test('plain variable substitution', () => {
  assert.equal(renderTemplate('{{ .Keywords }}', baseCtx({ Keywords: 'ubuntu' })), 'ubuntu');
});

test('substitution embedded inside surrounding literal text', () => {
  assert.equal(
    renderTemplate('https://{{ .Config.apiurl }}/search', baseCtx({ Config: { apiurl: 'apibay.org' } })),
    'https://apibay.org/search'
  );
});

test('if/else: keywords present vs absent (wiki\'s own search-path example)', () => {
  const tpl = '{{ if .Keywords }}search.php{{ else }}latest.php{{ end }}';
  assert.equal(renderTemplate(tpl, baseCtx({ Keywords: 'foo' })), 'search.php');
  assert.equal(renderTemplate(tpl, baseCtx({ Keywords: '' })), 'latest.php');
});

test('if with no else and a false condition renders nothing', () => {
  assert.equal(renderTemplate('x{{ if .Keywords }}y{{ end }}z', baseCtx()), 'xz');
});

test('or: returns the first non-empty operand, used both as a condition and as a value', () => {
  const tpl = '{{ if or (.Query.Album) (.Query.Artist) }}{{ or (.Query.Album) (.Query.Artist) }}{{ else }}{{ .Keywords }}{{ end }}';
  assert.equal(renderTemplate(tpl, baseCtx({ Query: { Album: 'Nevermind' }, Keywords: 'fallback' })), 'Nevermind');
  assert.equal(renderTemplate(tpl, baseCtx({ Query: { Artist: 'Nirvana' }, Keywords: 'fallback' })), 'Nirvana');
  assert.equal(renderTemplate(tpl, baseCtx({ Keywords: 'fallback' })), 'fallback');
});

test('and: true only when every operand is non-empty, returns the last value', () => {
  const tpl = '{{ if and (.Config.lang) (.Result.is_polish) }}{{ .Result.title_polish }}{{ else }}{{ .Result.title_phase1 }}{{ end }}';
  const ctx = baseCtx({
    Config: { lang: 'pl' },
    Result: { is_polish: 'True', title_polish: 'Polski Tytul', title_phase1: 'English Title' }
  });
  assert.equal(renderTemplate(tpl, ctx), 'Polski Tytul');

  const ctxMissingOne = baseCtx({ Config: {}, Result: { is_polish: 'True', title_phase1: 'English Title' } });
  assert.equal(renderTemplate(tpl, ctxMissingOne), 'English Title');
});

test('eq/ne: string equality only', () => {
  const tpl = '{{ if eq .Result._cat "series" }}512 MB{{ else }}2 GB{{ end }}';
  assert.equal(renderTemplate(tpl, baseCtx({ Result: { _cat: 'series' } })), '512 MB');
  assert.equal(renderTemplate(tpl, baseCtx({ Result: { _cat: 'movie' } })), '2 GB');
});

test('nested or(eq, or(eq, eq)) - the wiki\'s own worked nesting example', () => {
  const tpl = '{{ if or (eq .Result.cat "movie") (or (eq .Result.cat "movie_etc") (eq .Result.cat "movie_eng")) }}2 GB{{ else }}512 MB{{ end }}';
  assert.equal(renderTemplate(tpl, baseCtx({ Result: { cat: 'movie_eng' } })), '2 GB');
  assert.equal(renderTemplate(tpl, baseCtx({ Result: { cat: 'tv' } })), '512 MB');
});

test('.Vars.* resolves search.vars, extracted once per response - a missing key is empty, like .Result', () => {
  assert.equal(renderTemplate('{{ .Vars.token }}', baseCtx({ Vars: { token: 'abc123' } })), 'abc123');
  assert.equal(renderTemplate('{{ .Vars.missing }}', baseCtx({ Vars: { token: 'abc123' } })), '');
  assert.equal(renderTemplate('{{ .Vars.token }}', baseCtx()), '');
});

test('.Now resolves to whatever unix-seconds string the caller bound - not computed live by the template engine itself', () => {
  assert.equal(renderTemplate('{{ .Now }}', baseCtx({ Now: '1700000000' })), '1700000000');
  assert.equal(renderTemplate('{{ .Now }}', baseCtx()), '');
});

test('.True / .False special variables', () => {
  assert.equal(renderTemplate('{{ if .True }}yes{{ else }}no{{ end }}', baseCtx()), 'yes');
  assert.equal(renderTemplate('{{ if .False }}yes{{ else }}no{{ end }}', baseCtx()), 'no');
});

test('join: comma-separated category list (wiki example)', () => {
  assert.equal(renderTemplate('{{join .Categories ","}}', baseCtx({ Categories: ['101', '201', '301'] })), '101,201,301');
});

test('range: builds a repeated query-string fragment (wiki example)', () => {
  const tpl = '{{ range .Categories }}&cat{{.}}=1{{end}}';
  assert.equal(renderTemplate(tpl, baseCtx({ Categories: ['101', '201', '301'] })), '&cat101=1&cat201=1&cat301=1');
});

test('range with indexing: $i, $e := .Var (wiki example)', () => {
  const tpl = '{{ range $i, $e := .Categories }}&categories[{{$i}}]={{.}}{{end}}';
  assert.equal(renderTemplate(tpl, baseCtx({ Categories: ['101', '201', '301'] })), '&categories[0]=101&categories[1]=201&categories[2]=301');
});

test('range over an empty list renders nothing', () => {
  assert.equal(renderTemplate('x{{ range .Categories }}y{{end}}z', baseCtx({ Categories: [] })), 'xz');
});

test('inline filter call: re_replace used as a template function, not a field filter (wiki example)', () => {
  const tpl = '{{ re_replace .Keywords "[^a-zA-Z0-9]+" "*" }}';
  assert.equal(renderTemplate(tpl, baseCtx({ Keywords: 'the matrix!' })), 'the*matrix*');
});

test('.Config, .Result, .Query, .DownloadUri.Query paths resolve correctly', () => {
  assert.equal(renderTemplate('{{ .Config.username }}', baseCtx({ Config: { username: 'bob' } })), 'bob');
  assert.equal(renderTemplate('{{ .Result._id }}', baseCtx({ Result: { _id: '42' } })), '42');
  assert.equal(renderTemplate('{{ .Query.IMDBID }}', baseCtx({ Query: { IMDBID: 'tt1234567' } })), 'tt1234567');
  assert.equal(
    renderTemplate('{{ .DownloadUri.Query.id }}', baseCtx({ DownloadUri: { Query: { id: '37346' } } })),
    '37346'
  );
});

test('.DownloadUri.Host / .Scheme resolve as plain properties, not through .Query', () => {
  const ctx = baseCtx({ DownloadUri: { AbsoluteUri: 'x', AbsolutePath: 'x', Scheme: 'https', Host: 'domain.to', Port: '443', PathAndQuery: 'x', Query: {} } });
  assert.equal(renderTemplate('{{ .DownloadUri.Host }}', ctx), 'domain.to');
  assert.equal(renderTemplate('{{ .DownloadUri.Scheme }}', ctx), 'https');
});

test('a missing/undeclared path resolves to empty string rather than throwing', () => {
  assert.equal(renderTemplate('[{{ .Query.NoSuchThing }}]', baseCtx()), '[]');
});

test('YTS-style: multiple actions and a nested if all concatenated in one template string', () => {
  const tpl = '{{ .Result.year }}.{{ .Result._quality }}.{{ if eq .Result._type "web" }}WEBRip{{ else }}BRRip{{ end }}-YTS';
  const ctx = baseCtx({ Result: { year: '2020', _quality: '1080p', _type: 'web' } });
  assert.equal(renderTemplate(tpl, ctx), '2020.1080p.WEBRip-YTS');
});

test('an unknown function name throws rather than silently rendering empty', () => {
  assert.throws(() => renderTemplate('{{ notarealfunction .Keywords }}', baseCtx()), /unknown function/);
});

test('unmatched {{ end }} and unclosed {{ if }} both throw at parse time', () => {
  assert.throws(() => renderTemplate('{{ end }}', baseCtx()), /unmatched/);
  assert.throws(() => renderTemplate('{{ if .Keywords }}x', baseCtx()), /unclosed/);
});
