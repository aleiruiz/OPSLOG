import type { BffWorkOrder, BffWorkOrderStatus } from '@opslog/contracts';
import { BFF_MAINTENANCE_STATUSES } from '@opslog/contracts';
import { minorDigits } from '../incidents/money';
import type { ListFilters } from '../search/views/urlState';

/** Filters of the order list. Everything beyond the first three is optional so older callers keep working. */
export interface Filters {
  readonly status: '' | BffWorkOrderStatus;
  readonly vehicleId: string;
  readonly month: string;
  readonly kind?: '' | BffWorkOrder['kind'];
  /** Open orders whose scheduled day already passed. */
  readonly overdue?: boolean;
  /** Whole currency units; only for readers with `view_costs`. */
  readonly costFrom?: string;
  readonly costTo?: string;
}
export const NO_FILTERS: Filters = { status: '', vehicleId: '', month: '' };

const OPEN: readonly BffWorkOrderStatus[] = ['scheduled', 'assigned', 'in_progress'];

/** `YYYY-MM-DD` of the device's calendar day. */
export const todayLocal = (now: Date = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

export const isOverdue = (order: BffWorkOrder, today: string): boolean =>
  OPEN.includes(order.status) && order.scheduledDate !== null && order.scheduledDate < today;

/**
 * Sum of the order's cost lines in whole units, rounded down. `null` when the reader does not get costs or
 * the lines mix currencies (summing them would be wrong, so the order is not filtered by cost).
 */
export function costUnits(order: BffWorkOrder): bigint | null {
  if (!order.costs) return null;
  const currencies = new Set(order.costs.map((cost) => cost.amount.currency));
  if (currencies.size > 1) return null;
  const digits = minorDigits([...currencies][0] ?? 'MXN');
  const minor = order.costs.reduce((sum, cost) => sum + BigInt(cost.amount.amountMinor), 0n);
  return minor / 10n ** BigInt(digits);
}

export const matches = (order: BffWorkOrder, filters: Filters, today = todayLocal()): boolean => {
  if (filters.status !== '' && order.status !== filters.status) return false;
  if (filters.vehicleId !== '' && order.vehicleId !== filters.vehicleId) return false;
  if (filters.month !== '' && !(order.scheduledDate ?? '').startsWith(filters.month)) return false;
  if (filters.kind && order.kind !== filters.kind) return false;
  if (filters.overdue && !isOverdue(order, today)) return false;
  if (filters.costFrom || filters.costTo) {
    const units = costUnits(order);
    if (units === null) return true;
    if (filters.costFrom && units < BigInt(filters.costFrom)) return false;
    if (filters.costTo && units > BigInt(filters.costTo)) return false;
  }
  return true;
};

const isStatus = (value: string | undefined): value is BffWorkOrderStatus =>
  BFF_MAINTENANCE_STATUSES.includes(value as BffWorkOrderStatus);

/** The address keys of the list (`BFF_LIST_CATALOG.maintenance`) as the screen's filters. */
export const filtersFromUrl = (url: ListFilters): Filters => ({
  status: isStatus(url.status) ? url.status : '',
  vehicleId: url.vehicleId ?? '',
  month: url.month ?? '',
  kind: url.kind === 'preventive' || url.kind === 'corrective' ? url.kind : '',
  overdue: url.overdue === 'true',
  costFrom: url.costFrom ?? '',
  costTo: url.costTo ?? '',
});

export const filtersToUrl = (filters: Filters): Record<string, string> => ({
  ...(filters.status ? { status: filters.status } : {}),
  ...(filters.kind ? { kind: filters.kind } : {}),
  ...(filters.vehicleId ? { vehicleId: filters.vehicleId } : {}),
  ...(filters.month ? { month: filters.month } : {}),
  ...(filters.overdue ? { overdue: 'true' } : {}),
  ...(filters.costFrom ? { costFrom: filters.costFrom } : {}),
  ...(filters.costTo ? { costTo: filters.costTo } : {}),
});
