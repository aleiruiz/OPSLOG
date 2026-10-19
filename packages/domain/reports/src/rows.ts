import type { PersonFact } from './ports.js';

export const fullName = (person: Pick<PersonFact, 'firstName' | 'lastName'>): string =>
  `${person.firstName} ${person.lastName}`.trim();

/** Rows by key, so a definition can join facts without a quadratic scan. */
export function indexBy<T>(items: readonly T[], key: (item: T) => string): ReadonlyMap<string, T> {
  return new Map(items.map((item) => [key(item), item] as const));
}

export function groupBy<T>(
  items: readonly T[],
  key: (item: T) => string,
): ReadonlyMap<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = groups.get(k);
    if (group) group.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

/** A date-range filter test: the row's day must fall inside the bound; an empty day never passes. */
export const onOrAfter = (day: unknown, bound: unknown): boolean =>
  typeof day === 'string' && typeof bound === 'string' && day >= bound;
export const onOrBefore = (day: unknown, bound: unknown): boolean =>
  typeof day === 'string' && typeof bound === 'string' && day <= bound;

export const sameText = (cell: unknown, value: unknown): boolean =>
  typeof cell === 'string' &&
  typeof value === 'string' &&
  cell.toLocaleLowerCase('es') === value.toLocaleLowerCase('es');

export const containsText = (cell: unknown, value: unknown): boolean =>
  typeof cell === 'string' &&
  typeof value === 'string' &&
  cell.toLocaleLowerCase('es').includes(value.toLocaleLowerCase('es'));

/** Test of a filter the loader already applied to its facts: every row it produced passes. */
export const APPLIED = (): boolean => true;

export const vehicleLabel = (v: { economicNumber: string; plate: string }): string =>
  `${v.economicNumber} (${v.plate})`;

/** The value of a filter as text, when the request named it. */
export const textFilter = (
  filters: ReadonlyMap<string, string | number>,
  id: string,
): string | undefined => {
  const value = filters.get(id);
  return typeof value === 'string' ? value : undefined;
};

/** A day inside the optional bounds `from` and `to` (inclusive); an empty day passes only without bounds. */
export function inPeriod(
  day: string | null,
  filters: ReadonlyMap<string, string | number>,
): boolean {
  const from = textFilter(filters, 'from');
  const to = textFilter(filters, 'to');
  if (from === undefined && to === undefined) return true;
  if (day === null) return false;
  return (from === undefined || day >= from) && (to === undefined || day <= to);
}

/** Median and nearest-rank p90 of a list of numbers; null for an empty list. */
export function percentiles(values: readonly number[]): { median: number; p90: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return { median, p90: sorted[Math.ceil(0.9 * sorted.length) - 1] as number };
}

export const round = (value: number, digits: number): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** `10000` as `10,000`: the same text on every runtime, whatever locale data it ships. */
export const groupDigits = (value: number): string =>
  String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
