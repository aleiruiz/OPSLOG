import { dayIn, fromLocalInput } from '../incidents/time';

/** Longest range the server accepts (one year plus a leap day). */
export const MAX_RANGE_DAYS = 366;

const DAY = 86_400_000;

const toMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addDays = (day: string, days: number): string => fromMs(toMs(day) + days * DAY);

export interface Shortcut {
  readonly id: string;
  readonly label: string;
}
export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'today', label: 'Hoy' },
  { id: '7', label: 'Últimos 7 días' },
  { id: '30', label: 'Últimos 30 días' },
];

/** Calendar days `[from, to]` of a shortcut, counted on the company's wall clock. */
export function shortcutDays(id: string, now: number, zone: string): { from: string; to: string } {
  const today = dayIn(now, zone);
  return { from: id === 'today' ? today : addDays(today, -(Number(id) - 1)), to: today };
}

export type RangeResult =
  | { readonly ok: true; readonly from?: string; readonly to?: string }
  | { readonly ok: false; readonly message: string };

/**
 * Turns the two typed days (company zone, both inclusive) into the instants the server expects:
 * `from` is the start of the first day and `to` the start of the day after the last one.
 */
export function resolveRange(fromDay: string, toDay: string, zone: string): RangeResult {
  if (!fromDay && !toDay) return { ok: true };
  if (!fromDay || !toDay) return { ok: false, message: 'Indica la fecha inicial y la final.' };
  if (toMs(fromDay) > toMs(toDay))
    return { ok: false, message: 'La fecha inicial no puede ser posterior a la final.' };
  if ((toMs(toDay) - toMs(fromDay)) / DAY + 1 > MAX_RANGE_DAYS)
    return { ok: false, message: 'El rango no puede superar 366 días.' };
  const from = fromLocalInput(`${fromDay}T00:00`, zone);
  const to = fromLocalInput(`${addDays(toDay, 1)}T00:00`, zone);
  if (from === null || to === null) return { ok: false, message: 'Las fechas no son válidas.' };
  return { ok: true, from, to };
}
