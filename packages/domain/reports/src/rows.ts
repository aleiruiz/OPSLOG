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
