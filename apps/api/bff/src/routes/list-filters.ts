import {
  BFF_LIST_CATALOG,
  isValidFilterValue,
  type BffListModule,
} from '../../../../../packages/contracts/src/index.js';
import type { RouteContext } from './shared.js';

/**
 * Values of the §14.2 filters of a list (`BFF_LIST_CATALOG`) that the request carries, checked against the
 * contract: the same keys and values the address of the list and a saved view hold. `null` when one is invalid.
 */
export function catalogFilters(
  ctx: RouteContext,
  module: BffListModule,
  keys: readonly string[],
): Readonly<Record<string, string>> | null {
  const filters = BFF_LIST_CATALOG[module].filters as Readonly<
    Record<string, { spec: Parameters<typeof isValidFilterValue>[0] }>
  >;
  const found: Record<string, string> = {};
  for (const key of keys) {
    const value = ctx.query.get(key);
    if (value === null) continue;
    const filter = filters[key];
    if (!filter || !isValidFilterValue(filter.spec, value)) return null;
    found[key] = value;
  }
  return found;
}

/** The whole-number filters among `values`, as numbers. */
export function numbers(
  values: Readonly<Record<string, string>>,
  keys: readonly string[],
): Record<string, number> {
  return Object.fromEntries(
    keys.filter((key) => key in values).map((key) => [key, Number(values[key])]),
  );
}
