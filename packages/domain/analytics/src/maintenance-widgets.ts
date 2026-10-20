import type { ClosedOrderFact } from './ports.js';
import { percentOf } from './stats.js';
import type { CurrencyTotal } from './types.js';

export interface OnTime {
  readonly numerator: number;
  readonly denominator: number;
  readonly percent: number | null;
  /** Preventive orders closed in the range that cannot be judged: no planned date or no real date. */
  readonly excluded: number;
}

/**
 * Preventive maintenance on time: closed preventive orders whose real date is on or before the
 * planned date, over the closed preventive orders that have both dates. Orders have no km target of
 * their own, so the km criterion of the plan is not judged here (see the task document).
 */
export function maintenanceOnTime(orders: readonly ClosedOrderFact[]): OnTime {
  let numerator = 0;
  let denominator = 0;
  let excluded = 0;
  for (const order of orders) {
    if (order.kind !== 'preventive') continue;
    if (order.scheduledDate === null || order.actualDate === null) {
      excluded += 1;
      continue;
    }
    denominator += 1;
    if (order.actualDate <= order.scheduledDate) numerator += 1;
  }
  return { numerator, denominator, percent: percentOf(numerator, denominator), excluded };
}

/** Sum of the cost lines per currency, exact (minor units as integers), currencies in code order. */
export function costByCurrency(orders: readonly ClosedOrderFact[]): readonly CurrencyTotal[] {
  const totals = new Map<string, bigint>();
  for (const order of orders)
    for (const cost of order.costs)
      totals.set(cost.currency, (totals.get(cost.currency) ?? 0n) + BigInt(cost.amountMinor));
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, amount]) => ({ currency, amountMinor: amount.toString() }));
}
