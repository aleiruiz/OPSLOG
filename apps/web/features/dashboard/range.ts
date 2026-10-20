import { addDays } from '../audit/range';

export type RangeChoice = 'default' | 'today' | '7' | 'month' | 'quarter' | 'custom';

export const RANGE_CHOICES: readonly { id: RangeChoice; label: string }[] = [
  { id: 'today', label: 'Hoy' },
  { id: '7', label: '7 días' },
  { id: 'default', label: '30 días' },
  { id: 'month', label: 'Mes en curso' },
  { id: 'quarter', label: 'Trimestre en curso' },
  { id: 'custom', label: 'Personalizado' },
];

/** Closed range of company days for a shortcut; `today` is the company's day, never the browser's. */
export function rangeOf(choice: RangeChoice, today: string): { from: string; to: string } | null {
  switch (choice) {
    case 'today':
      return { from: today, to: today };
    case '7':
      return { from: addDays(today, -6), to: today };
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
    case 'quarter': {
      const month = Number(today.slice(5, 7));
      const first = String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0');
      return { from: `${today.slice(0, 5)}${first}-01`, to: today };
    }
    case 'default':
    case 'custom':
      return null;
  }
}

const MAX_DAYS = 366;
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** Message when a typed range cannot be asked for; null when it can. */
export function customRangeError(from: string, to: string): string | null {
  if (!from || !to) return 'Indica la fecha inicial y la final.';
  if (ms(from) > ms(to)) return 'La fecha inicial no puede ser posterior a la final.';
  if ((ms(to) - ms(from)) / 86_400_000 + 1 > MAX_DAYS) return 'El rango no puede superar 366 días.';
  return null;
}
