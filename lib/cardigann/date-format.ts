// .NET custom date/time format tokens, as used by dateparse/timeparse's
// second argument (wiki.servarr.com/prowlarr/cardigann-yml-definition,
// "Filters" > dateparse). Longest-token-first so "yyyy" isn't consumed as
// four separate "y"s before ever matching "yyyy" - tokens here are checked
// in this exact order at every position of the format string.
const TOKENS: [string, string][] = [
  ['yyyy', '(?<yyyy>\\d{4})'],
  ['yy', '(?<yy>\\d{2})'],
  ['MMMM', '(?<MMMM>[A-Za-z]+)'],
  ['MMM', '(?<MMM>[A-Za-z]{3})'],
  ['MM', '(?<MM>\\d{2})'],
  ['M', '(?<M>\\d{1,2})'],
  ['dddd', '(?<dddd>[A-Za-z]+)'],
  ['ddd', '(?<ddd>[A-Za-z]{3})'],
  ['dd', '(?<dd>\\d{2})'],
  ['d', '(?<d>\\d{1,2})'],
  ['HH', '(?<HH>\\d{2})'],
  ['H', '(?<H>\\d{1,2})'],
  ['hh', '(?<hh>\\d{2})'],
  ['h', '(?<h>\\d{1,2})'],
  ['mm', '(?<mm>\\d{2})'],
  ['m', '(?<m>\\d{1,2})'],
  ['ss', '(?<ss>\\d{2})'],
  ['s', '(?<s>\\d{1,2})'],
  ['ffff', '(?<ffff>\\d{4})'],
  ['fff', '(?<fff>\\d{3})'],
  ['ff', '(?<ff>\\d{2})'],
  ['f', '(?<f>\\d{1})'],
  ['tt', '(?<tt>[AaPp][Mm])'],
  ['zzz', '(?<zzz>[+-]\\d{2}:?\\d{2})'],
  ['zz', '(?<zz>[+-]\\d{2})']
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRegex(format: string): RegExp {
  let pattern = '';
  let i = 0;
  while (i < format.length) {
    const token = TOKENS.find(([t]) => format.startsWith(t, i));
    if (token) {
      pattern += token[1];
      i += token[0].length;
    } else {
      pattern += escapeRegex(format[i] as string);
      i += 1;
    }
  }
  return new RegExp(pattern);
}

function monthFromName(name: string): number | null {
  const idx = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return idx === -1 ? null : idx + 1;
}

// Parses `value` against a .NET custom format string (dateparse/timeparse's
// args), returns null rather than throwing on no match - filters degrade to
// an empty string on a bad parse elsewhere, not a crash.
export function parseWithFormat(value: string, format: string): Date | null {
  const regex = buildRegex(format);
  const match = regex.exec(value);
  if (!match || !match.groups) return null;
  const g = match.groups;

  const year = g.yyyy ? Number(g.yyyy) : g.yy ? (Number(g.yy) < 70 ? 2000 + Number(g.yy) : 1900 + Number(g.yy)) : new Date().getUTCFullYear();
  let month = g.MM ? Number(g.MM) : g.M ? Number(g.M) : g.MMMM ? monthFromName(g.MMMM) : g.MMM ? monthFromName(g.MMM) : 1;
  if (month === null) month = 1;
  const day = g.dd ? Number(g.dd) : g.d ? Number(g.d) : 1;

  let hour = g.HH ? Number(g.HH) : g.H ? Number(g.H) : g.hh ? Number(g.hh) : g.h ? Number(g.h) : 0;
  if ((g.hh || g.h) && g.tt) {
    const isPM = g.tt.toLowerCase() === 'pm';
    hour = (hour % 12) + (isPM ? 12 : 0);
  }

  const minute = g.mm ? Number(g.mm) : g.m ? Number(g.m) : 0;
  const second = g.ss ? Number(g.ss) : g.s ? Number(g.s) : 0;
  const ms = g.fff ? Number(g.fff) : g.ff ? Number(g.ff) * 10 : g.f ? Number(g.f) * 100 : g.ffff ? Math.round(Number(g.ffff) / 10) : 0;

  let offsetMinutes = 0;
  if (g.zzz) {
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(g.zzz);
    if (m) offsetMinutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  } else if (g.zz) {
    const m = /^([+-])(\d{2})$/.exec(g.zz);
    if (m) offsetMinutes = (m[1] === '-' ? -1 : 1) * Number(m[2]) * 60;
  }

  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMinutes * 60000;
  const result = new Date(utcMillis);
  return Number.isNaN(result.getTime()) ? null : result;
}

// dateparse/timeparse/timeago/reltime/fuzzytime all output this shape
// ("ddd, dd MMM yyyy HH:mm:ss z", e.g. "Mon, 18 Sep 2017 19:17:24 GMT") per
// the wiki. Chosen deliberately: it's a valid RFC 2822 date string, so it
// round-trips cleanly through JS's own `new Date(str)` at field-extraction
// time without needing a second custom parser there.
export function formatRFC1123(date: Date): string {
  return date.toUTCString();
}
