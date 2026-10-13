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

/** The wall clock of an instant in a zone, expressed as if it were UTC (so differences are offsets). */
function wallOf(ms: number, zone: string): number {
  const parts = Object.fromEntries(
    formatOf(zone)
      .formatToParts(new Date(ms))
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  const millis = ((ms % 1000) + 1000) % 1000;
  return Date.UTC(
    parts['year'] as number,
    (parts['month'] as number) - 1,
    parts['day'] as number,
    parts['hour'] as number,
    parts['minute'] as number,
    parts['second'] as number,
    millis,
  );
}
const offsetAt = (ms: number, zone: string): number => wallOf(ms, zone) - ms;

const WINDOW_MS = 86_400_000;

/**
 * The instant `days` calendar days after `start` at the same local time in `zone` (D17): a deadline
 * lands on the hour of the report, not at midnight UTC, and a daylight-saving change does not move
 * it. A local time that does not exist that day (a spring-forward gap) moves forward to the first
 * instant after the gap; one that exists twice (a fall-back overlap) is the earlier instant.
 */
export function addCalendarDays(start: string, days: number, zone: string): string {
  const startMs = Date.parse(start);
  const local = wallOf(startMs, zone);
  const date = new Date(local);
  date.setUTCDate(date.getUTCDate() + days);
  const wall = date.getTime();
  // Offsets a day either side of the target bracket any transition of that day.
  const before = wall - offsetAt(wall - WINDOW_MS, zone);
  const after = wall - offsetAt(wall + WINDOW_MS, zone);
  const valid = [before, after].filter((ms) => wallOf(ms, zone) === wall);
  return new Date(valid.length > 0 ? Math.min(...valid) : before).toISOString();
}
