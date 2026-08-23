// timeago/reltime/fuzzytime (lib/cardigann/filters.ts). Wiki examples:
// "2 hours and 1 day", "4 years ago", "9hr,12m,39s",
// "8 days 3 hours 12 minutes 10 seconds", "now".
const UNIT_PATTERNS: [RegExp, number][] = [
  [/\b(\d+)\s*(?:years?|yrs?)\b/gi, 365.25 * 24 * 3600 * 1000],
  [/\b(\d+)\s*(?:months?|mos?)\b/gi, 30 * 24 * 3600 * 1000],
  [/\b(\d+)\s*(?:weeks?|wks?)\b/gi, 7 * 24 * 3600 * 1000],
  [/\b(\d+)\s*(?:days?)\b/gi, 24 * 3600 * 1000],
  [/\b(\d+)\s*(?:hours?|hrs?|h)\b/gi, 3600 * 1000],
  [/\b(\d+)\s*(?:minutes?|mins?|m)\b/gi, 60 * 1000],
  [/\b(\d+)\s*(?:seconds?|secs?|s)\b/gi, 1000]
];

// null means "found no recognizable unit at all", distinct from a
// legitimate zero offset - lets callers fall through to another parser
// instead of silently treating unrelated text as "now".
export function parseTimeAgo(value: string, now: Date = new Date()): Date | null {
  const trimmed = value.trim();
  if (/^now$/i.test(trimmed)) return now;

  let totalMs = 0;
  let matchedAny = false;
  for (const [pattern, unitMs] of UNIT_PATTERNS) {
    for (const m of trimmed.matchAll(pattern)) {
      totalMs += Number(m[1]) * unitMs;
      matchedAny = true;
    }
  }
  return matchedAny ? new Date(now.getTime() - totalMs) : null;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// fuzzytime. The wiki's documented "UK" arg (dd-MM instead of MM-dd) is
// explicitly NOT implemented in Prowlarr's own Cardigann engine either
// (filter args are ignored there) - matched here for the same reason:
// implementing it would produce output that diverges from what real
// Prowlarr-authored definitions actually get when run.
export function parseFuzzyTime(value: string, now: Date = new Date()): Date | null {
  const trimmed = value.trim();

  if (/^now$/i.test(trimmed)) return now;
  if (/^today$/i.test(trimmed)) return now;
  if (/^yesterday$/i.test(trimmed)) return new Date(now.getTime() - 24 * 3600 * 1000);
  if (/^tomorrow$/i.test(trimmed)) return new Date(now.getTime() + 24 * 3600 * 1000);

  if (/^\d+$/.test(trimmed)) {
    const asUnixSeconds = new Date(Number(trimmed) * 1000);
    if (!Number.isNaN(asUnixSeconds.getTime())) return asUnixSeconds;
  }

  const relative = parseTimeAgo(trimmed, now);
  if (relative) return relative;

  const mmdd = /^(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (mmdd) {
    const [, mm, dd] = mmdd;
    return new Date(Date.UTC(now.getUTCFullYear(), Number(mm) - 1, Number(dd)));
  }

  const dayMonth = /^(\d{1,2})\s+([A-Za-z]{3,})$/.exec(trimmed);
  if (dayMonth) {
    const [, day, monthName] = dayMonth;
    const monthIdx = MONTHS.indexOf((monthName as string).slice(0, 3).toLowerCase());
    if (monthIdx !== -1) return new Date(Date.UTC(now.getUTCFullYear(), monthIdx, Number(day)));
  }

  const weekdayAt = /^([A-Za-z]+)\s+at\s+(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (weekdayAt) {
    const [, weekdayName, hh, mm] = weekdayAt;
    const targetDow = WEEKDAYS.indexOf((weekdayName as string).toLowerCase());
    if (targetDow !== -1) {
      const result = new Date(now);
      const diff = (result.getUTCDay() - targetDow + 7) % 7;
      result.setUTCDate(result.getUTCDate() - diff);
      result.setUTCHours(Number(hh), Number(mm), 0, 0);
      return result;
    }
  }

  const native = new Date(trimmed);
  return Number.isNaN(native.getTime()) ? null : native;
}
