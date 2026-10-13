/**
 * Dates of an incident are shown, and typed, in the company's time zone (SPECS §2.3): the event instant
 * travels as UTC and the screens never use the browser's zone by accident. A zone the browser does not
 * know falls back to UTC rather than throwing.
 */
export const DEFAULT_ZONE = 'UTC';

function safeZone(zone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_ZONE;
  }
}

interface Wall {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

function wallTime(instant: number, zone: string): Wall {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: safeZone(zone),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(instant));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
  };
}

const two = (value: number) => String(value).padStart(2, '0');

/** `13/10/2026 14:30` in the company's zone; `Sin fecha` when there is no instant. */
export function formatDateTime(iso: string | null, zone: string): string {
  if (iso === null) return 'Sin fecha';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return 'Sin fecha';
  const wall = wallTime(time, zone);
  return `${two(wall.day)}/${two(wall.month)}/${wall.year} ${two(wall.hour)}:${two(wall.minute)}`;
}

/** A calendar day `2026-10-12` as `12/10/2026`: calendar days never shift with a zone. */
export const formatDay = (day: string | null): string =>
  day ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : 'Sin fecha';

/** Value of a `datetime-local` input (`2026-10-13T14:30`) for an instant, in the company's zone. */
export function toLocalInput(iso: string | null, zone: string): string {
  const time = iso === null ? Number.NaN : Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const wall = wallTime(time, zone);
  return `${wall.year}-${two(wall.month)}-${two(wall.day)}T${two(wall.hour)}:${two(wall.minute)}`;
}

/** The instant (ISO, UTC) of a `datetime-local` value typed as wall time in the company's zone; `null` if blank or invalid. */
export function fromLocalInput(local: string, zone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const checked = new Date(asUtc);
  // A wall time that does not exist on the calendar (month 13, 45th day, hour 99) is not an instant.
  if (
    checked.getUTCMonth() !== month - 1 ||
    checked.getUTCDate() !== day ||
    checked.getUTCHours() !== hour ||
    checked.getUTCMinutes() !== minute
  )
    return null;
  // The zone's offset at that wall time; resolved twice so a daylight-saving boundary settles.
  const offsetAt = (instant: number) => {
    const wall = wallTime(instant, zone);
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - instant;
  };
  let instant = asUtc - offsetAt(asUtc);
  instant = asUtc - offsetAt(instant);
  const result = new Date(instant);
  return Number.isNaN(result.getTime()) ? null : result.toISOString();
}

/** Whole days between an instant and now (never negative): "días en el estado". */
export function daysSince(iso: string, now: number = Date.now()): number {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? 0 : Math.max(0, Math.floor((now - time) / 86_400_000));
}
