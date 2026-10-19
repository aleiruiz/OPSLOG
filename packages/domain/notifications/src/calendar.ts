import { QUIET_END_HOUR, QUIET_START_HOUR } from './types.js';

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
  return Date.UTC(
    parts['year'] as number,
    (parts['month'] as number) - 1,
    parts['day'] as number,
    parts['hour'] as number,
    parts['minute'] as number,
    parts['second'] as number,
  );
}

/** The `YYYY-MM-DD` day of an instant in the company's zone. */
export function dayIn(instant: Date, zone: string): string {
  return new Date(wallOf(instant.getTime(), zone)).toISOString().slice(0, 10);
}

/** The first instant at which the wall clock of `zone` shows `wall` (a gap moves forward, an overlap takes the earlier). */
function instantOf(wall: number, zone: string): number {
  const day = 86_400_000;
  const before = wall - (wallOf(wall - day, zone) - (wall - day));
  const after = wall - (wallOf(wall + day, zone) - (wall + day));
  const valid = [before, after].filter((ms) => wallOf(ms, zone) === wall);
  return valid.length > 0 ? Math.min(...valid) : before;
}

/** Whether an instant falls in the quiet hours (22:00 to 07:00) of the zone. */
export function isQuiet(instant: Date, zone: string): boolean {
  const hour = new Date(wallOf(instant.getTime(), zone)).getUTCHours();
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

/**
 * The instant an external notice may go out: now, or 07:00 local when the quiet hours are on and it
 * is night in the zone. In-app notices never wait.
 */
export function notBefore(now: Date, zone: string, quietHours: boolean): Date {
  if (!quietHours || !isQuiet(now, zone)) return now;
  const wall = new Date(wallOf(now.getTime(), zone));
  if (wall.getUTCHours() >= QUIET_START_HOUR) wall.setUTCDate(wall.getUTCDate() + 1);
  wall.setUTCHours(QUIET_END_HOUR, 0, 0, 0);
  return new Date(instantOf(wall.getTime(), zone));
}
