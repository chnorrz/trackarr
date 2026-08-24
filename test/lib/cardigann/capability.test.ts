import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { checkCapability } = await import(path.join(ROOT, 'dist', 'lib', 'cardigann', 'capability.js'));

// A minimal, otherwise-valid definition shape - individual tests mutate a
// clone of this rather than repeating all the required boilerplate.
function baseDefinition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'test-tracker',
    type: 'public',
    search: {
      rows: { selector: 'tr' },
      fields: {
        title: { selector: 'a' },
        size: { text: '0 B' },
        seeders: { text: '0' },
        category: { text: '8000' },
        download: { selector: 'a', attribute: 'href' }
      }
    },
    ...overrides
  };
}

test('checkCapability: an otherwise-clean public definition passes with no reasons', () => {
  assert.deepEqual(checkCapability(baseDefinition()), []);
});

test('checkCapability: private/semi-private type is rejected', () => {
  assert.match(checkCapability(baseDefinition({ type: 'private' }))[0], /type: private/);
  assert.match(checkCapability(baseDefinition({ type: 'semi-private' }))[0], /type: semi-private/);
});

test('checkCapability: any login block is rejected, naming the method', () => {
  const reasons = checkCapability(baseDefinition({ login: { method: 'form', path: 'login.php' } }));
  assert.match(reasons[0], /login\.method: form/);
});

test('checkCapability: settings without a default are NOT rejected (unset .Config.* resolves to "")', () => {
  const def = baseDefinition({ settings: [{ name: 'uploader', type: 'text' }] });
  assert.deepEqual(checkCapability(def), []);
});

test('checkCapability: settings.type: multi-select is rejected regardless of default (broken even in Prowlarr)', () => {
  const def = baseDefinition({ settings: [{ name: 'quality', type: 'multi-select', default: ['1080p'] }] });
  assert.match(checkCapability(def)[0], /multi-select/);
});

test('checkCapability: search.rows.dateheaders is rejected', () => {
  const def = baseDefinition();
  (def.search as Record<string, unknown>).rows = { selector: 'tr', dateheaders: { selector: 'td.date' } };
  assert.match(checkCapability(def)[0], /rows\.dateheaders/);
});

test('checkCapability: search.rows.after is rejected', () => {
  const def = baseDefinition();
  (def.search as Record<string, unknown>).rows = { selector: 'tr', after: 1 };
  assert.match(checkCapability(def)[0], /rows\.after/);
});

test('checkCapability: an unsupported field filter is rejected by name, with its location', () => {
  const def = baseDefinition();
  (def.search as { fields: Record<string, unknown> }).fields.title = {
    selector: 'a',
    filters: [{ name: 'jsonjoinarray', args: ['$.x', ','] }]
  };
  const reasons = checkCapability(def);
  assert.match(reasons[0], /unsupported filter: jsonjoinarray/);
  assert.match(reasons[0], /fields\.title\.filters/);
});

test('checkCapability: an unsupported row filter is rejected using the RowFilterBlock vocabulary, not FilterBlock\'s', () => {
  const def = baseDefinition();
  (def.search as Record<string, unknown>).rows = { selector: 'tr', filters: [{ name: 'trim' }] };
  const reasons = checkCapability(def);
  // 'trim' is a valid *field* filter but not a valid *row* filter (only
  // andmatch/strdump) - this must still be flagged.
  assert.match(reasons[0], /unsupported filter: trim/);
  assert.match(reasons[0], /search\.rows\.filters/);
});

test('checkCapability: sha256/concat (trackarr-only extension filters) are accepted as field filters', () => {
  const def = baseDefinition();
  (def.search as { fields: Record<string, unknown> }).fields.title = {
    selector: 'a',
    filters: [{ name: 'concat', args: 'x' }, { name: 'sha256' }]
  };
  assert.deepEqual(checkCapability(def), []);
});

test('checkCapability: known row filters (andmatch, strdump) are accepted', () => {
  const def = baseDefinition();
  (def.search as Record<string, unknown>).rows = {
    selector: 'tr',
    filters: [{ name: 'andmatch' }, { name: 'strdump' }]
  };
  assert.deepEqual(checkCapability(def), []);
});

test('checkCapability: keywordsfilters and preprocessingfilters are checked too, not just field/row filters', () => {
  const def = baseDefinition({ search: { ...(baseDefinition().search as object), keywordsfilters: [{ name: 'not_a_real_filter' }] } });
  const reasons = checkCapability(def);
  assert.ok(reasons.some((r: string) => r.includes('unsupported filter: not_a_real_filter') && r.includes('keywordsfilters')));
});

test('checkCapability: infohash and download.before are NOT rejected (documented, bounded features)', () => {
  const def = baseDefinition({
    download: {
      before: { path: 'thanks.php', inputs: { id: '{{ .DownloadUri.Query.id }}' } },
      infohash: {
        hash: { selector: 'a[href^="magnet:"]', attribute: 'href', filters: [{ name: 'regexp', args: '([A-F0-9]{40})' }] },
        title: { selector: 'meta[property="og:title"]', attribute: 'content' }
      }
    }
  });
  assert.deepEqual(checkCapability(def), []);
});

test('checkCapability: multiple reasons accumulate rather than stopping at the first', () => {
  const def = baseDefinition({ type: 'private', login: { method: 'post' } });
  const reasons = checkCapability(def);
  assert.equal(reasons.length, 2);
});
