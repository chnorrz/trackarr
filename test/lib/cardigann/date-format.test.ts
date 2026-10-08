import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { parseWithFormat, formatRFC1123 } = await import(
  path.join(ROOT, 'dist', 'lib', 'cardigann', 'date-format.js')
);

// Each (format, input) pair below is copied from a real definition in
// Prowlarr/Indexers' definitions/v11 tree (not invented), to prove the
// format tokens this parser actually needs to support in production.
const cases: [string, string, string, string][] = [
  ['yyyy-MM-dd HH:mm:ss zzz', '2024-03-27 18:34:05 +08:00', '2024-03-27T10:34:05.000Z', 'u3c3/azusa/pthome/u2 - colon offset'],
  ['yyyy-MM-dd HH:mm:ss zzz', '2024-03-27 18:34:05 +0800', '2024-03-27T10:34:05.000Z', 'anibt/pandacd - no-colon offset'],
  ['yyyy-MM-ddHH:mm:ss zzz', '2024-03-2718:34:05 +08:00', '2024-03-27T10:34:05.000Z', 'azusa/pthome/siqi - no separator between date and time'],
  ['d-MM-yyyy HH:mm', '27-03-2021 18:34', '2021-03-27T18:34:00.000Z', 'aussierules - day-first, no leading zero on day'],
  ['MM/dd HH:mm', '03/27 18:34', undefined as unknown as string, 'btetree - no year at all'],
  ['/yyyy/MM/dd zzz', '/2024/03/27 -07:00', '2024-03-27T07:00:00.000Z', 'onejav - leading slash literal'],
  ['dd MMM yy zzz', '27 Mar 21 +03:00', '2021-03-26T21:00:00.000Z', 'xxxtor - 2-digit year'],
  ['MMM d, yyyy, h:mm tt zzz', 'Mar 27, 2024, 7:05 PM +00:00', '2024-03-27T19:05:00.000Z', 'shanaproject - 12-hour with minutes'],
  ['MMM d, yyyy, h tt zzz', 'Mar 27, 2024, 7 PM +00:00', '2024-03-27T19:00:00.000Z', 'shanaproject - 12-hour, hour only'],
  ['yyyy/MM/dd HH:mm zzz', '2024/03/27 18:34 +08:00', '2024-03-27T10:34:00.000Z', 'mikan'],
  ['yyyy-MM-dd', '2024-03-27', '2024-03-27T00:00:00.000Z', '0magnet - date only']
];

for (const [format, input, expectedIso, source] of cases) {
  test(`parseWithFormat: ${source} (${format})`, () => {
    const result = parseWithFormat(input, format);
    assert.ok(result, `expected a parsed date for ${JSON.stringify(input)}`);
    if (expectedIso) {
      assert.equal(result.toISOString(), expectedIso);
    } else {
      // No year in the format: today's UTC year is assumed. Just check the
      // month/day/time landed correctly rather than pinning a moving year.
      assert.equal(result.getUTCMonth(), 2);
      assert.equal(result.getUTCDate(), 27);
      assert.equal(result.getUTCHours(), 18);
      assert.equal(result.getUTCMinutes(), 34);
    }
  });
}

test('parseWithFormat: zzz accepts both +HH:mm and +HHmm offset forms identically', () => {
  const a = parseWithFormat('2024-03-27 18:34:05 +08:00', 'yyyy-MM-dd HH:mm:ss zzz');
  const b = parseWithFormat('2024-03-27 18:34:05 +0800', 'yyyy-MM-dd HH:mm:ss zzz');
  assert.equal(a.toISOString(), b.toISOString());
});

test('parseWithFormat: negative offset subtracts correctly', () => {
  const result = parseWithFormat('2024-03-27 18:34:05 -0500', 'yyyy-MM-dd HH:mm:ss zzz');
  assert.equal(result.toISOString(), '2024-03-27T23:34:05.000Z');
});

test('parseWithFormat: 12-hour boundary (12 AM = 00, 12 PM = 12)', () => {
  const am = parseWithFormat('12:30 AM', 'h:mm tt');
  const pm = parseWithFormat('12:30 PM', 'h:mm tt');
  assert.equal(am.getUTCHours(), 0);
  assert.equal(pm.getUTCHours(), 12);
});

test('parseWithFormat: returns null on a non-matching input', () => {
  assert.equal(parseWithFormat('not a date', 'yyyy-MM-dd'), null);
});

test('formatRFC1123: renders an RFC 2822-compatible string', () => {
  const date = new Date(Date.UTC(2017, 8, 18, 19, 17, 24));
  assert.equal(formatRFC1123(date), 'Mon, 18 Sep 2017 19:17:24 GMT');
});
