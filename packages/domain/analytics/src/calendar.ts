/** Calendar helpers of the dashboard: every day is a `YYYY-MM-DD` day of the company's IANA zone. */

export const DAY_MS = 86_400_000;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar day written as `YYYY-MM-DD` (no `2026-02-30`). */
export function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DAY.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

const utcMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);

export function addDays(day: string, days: number): string {
  return new Date(utcMs(day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcMs(to) - utcMs(from)) / DAY_MS);
}

/** `YYYY-MM` of a day. */
export const monthOf = (day: string): string => day.slice(0, 7);

/** Every `YYYY-MM` from the month of `from` to the month of `to`, both included, in order. */
export function monthsBetween(from: string, to: string): readonly string[] {
  const months: string[] = [];
  let [year, month] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))] as [number, number];
  const last = monthOf(to);
  for (;;) {
    const key = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
    months.push(key);
    if (key >= last) return months;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();

function formatOf(zone: string): Intl.DateTimeFormat {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formats.set(zone, format);
  }
  return format;
}

/** The wall clock of an instant in a zone, written as if it were UTC (so differences are offsets). */
function wallOf(ms: number, zone: string): number {
  const parts = Object.fromEntries(
    formatOf(zone)
      .formatToParts(new Date(ms))
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return Date.UTC(
    parts['year'] as number,
    (parts['month'] as number) - 1,
    parts['day'] as number,
    parts['hour'] as number,
    parts['minute'] as number,
    parts['second'] as number,
  );
}

/** The company's calendar day of an instant ("today" is `dayOf(now, zone)`). */
export function dayOf(instant: Date | number | string, zone: string): string {
  const ms = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  return new Date(wallOf(ms, zone)).toISOString().slice(0, 10);
}

const offsetAt = (ms: number, zone: string): number => wallOf(ms, zone) - (ms - (ms % 1000));

/**
 * The first instant (epoch milliseconds) of a company day. A midnight that does not exist (a
 * daylight-saving gap) starts at the first instant after the gap; one that exists twice starts at
 * the earlier instant. Days are half open: `[dayStart(d), dayStart(d + 1))`.
 */
export function dayStart(day: string, zone: string): number {
  const wall = utcMs(day);
  // Offsets a day either side of the target bracket any transition of that day.
  const before = wall - offsetAt(wall - DAY_MS, zone);
  const after = wall - offsetAt(wall + DAY_MS, zone);
  const valid = [before, after].filter((ms) => wallOf(ms, zone) === wall);
  return valid.length > 0 ? Math.min(...valid) : Math.max(before, after);
}

/** The last millisecond of a company day. */
export const dayEnd = (day: string, zone: string): number => dayStart(addDays(day, 1), zone) - 1;
