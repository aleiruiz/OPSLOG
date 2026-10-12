import type { Money, WorkOrder, WorkOrderCost, WorkOrderTransition } from './types.js';

export interface WorkOrderPartView {
  readonly id: string;
  readonly name: string;
  readonly quantity: string;
  /** Present only for callers with `view_costs`. */
  readonly unitCost?: Money | null;
}
/** Shown while a workshop episode is open: a suggestion, never an automatic vehicle change (D11). */
export interface VehicleProposal {
  readonly suggestedStatus: 'in_maintenance';
  readonly eligibilityBlocked: true;
}
export type WorkOrderView = Omit<WorkOrder, 'tenantId' | 'parts' | 'costs'> & {
  readonly parts: readonly WorkOrderPartView[];
  /** Present only for callers with `view_costs`. */
  readonly costs?: readonly WorkOrderCost[];
  readonly vehicleProposal: VehicleProposal | null;
};
export type WorkOrderTransitionView = Omit<WorkOrderTransition, 'tenantId'>;

const without = <T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> =>
  Object.fromEntries(
    Object.entries(value).filter(([key]) => !(keys as readonly string[]).includes(key)),
  ) as Omit<T, K>;

/** Drops the tenant and, without `view_costs`, every amount and currency of the order. */
export function workOrderView(order: WorkOrder, viewCosts: boolean): WorkOrderView {
  const { parts, costs } = order;
  return {
    ...without(order, ['tenantId', 'parts', 'costs']),
    parts: parts.map(({ unitCost, ...part }) => (viewCosts ? { ...part, unitCost } : part)),
    ...(viewCosts ? { costs } : {}),
    vehicleProposal:
      order.requiresWorkshop && order.status === 'in_progress'
        ? { suggestedStatus: 'in_maintenance', eligibilityBlocked: true }
        : null,
  };
}

export function transitionView(value: WorkOrderTransition): WorkOrderTransitionView {
  return without(value, ['tenantId']);
}
