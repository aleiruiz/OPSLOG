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
