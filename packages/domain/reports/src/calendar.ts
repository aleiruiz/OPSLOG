const DAY_MS = 86_400_000;
const utcMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);

/** The `YYYY-MM-DD` day of an instant in an IANA zone. */
export function dayInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number =>
  Math.round((utcMs(to) - utcMs(from)) / DAY_MS);

export const isDay = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(utcMs(value)).toISOString().slice(0, 10) === value;
};

/** The `YYYY-MM-DD` day `count` days after (or before, if negative) `day`. */
export const addDays = (day: string, count: number): string =>
  new Date(utcMs(day) + count * DAY_MS).toISOString().slice(0, 10);

/** Milliseconds the zone is ahead of UTC at an instant. */
function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const part = (type: string): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const local = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return local - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant (UTC) at which `day` begins in the zone. */
export function startOfDay(day: string, timeZone: string): Date {
  const guess = utcMs(day);
  const first = guess - offsetMs(new Date(guess), timeZone);
  return new Date(guess - offsetMs(new Date(first), timeZone));
}

/** The `YYYY-MM-DD HH:mm` of an instant in the zone, for tables that print moments. */
export function momentInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const part = (type: string): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}
