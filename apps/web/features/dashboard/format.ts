const number = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 });

export const formatCount = (value: number): string => number.format(value);

/** `87,5 %`, or «Sin datos» when the denominator was 0 (never 0 % or 100 %). */
export const formatPercent = (percent: number | null): string =>
  percent === null ? 'Sin datos' : `${number.format(percent)} %`;

export const formatDays = (days: number | null): string =>
  days === null ? 'Sin datos' : `${number.format(days)} ${days === 1 ? 'día' : 'días'}`;

/** Amount in the currency's minor unit (digits), shown in that currency. Currencies are never added. */
export function formatMoney(amountMinor: string, currency: string): string {
  try {
    const format = new Intl.NumberFormat('es-MX', { style: 'currency', currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return `${format.format(Number(amountMinor) / 10 ** digits)} ${currency}`;
  } catch {
    return `${amountMinor} ${currency}`;
  }
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** `2026-10` as `oct 2026`. */
export const formatMonth = (month: string): string =>
  `${MONTHS[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7)} ${month.slice(0, 4)}`;
