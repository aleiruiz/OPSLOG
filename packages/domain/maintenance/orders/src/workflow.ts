import { WorkOrderError } from './errors.js';
import type { WorkOrder, WorkOrderCommand, WorkOrderStatus } from './types.js';

/** SPECS §6.1 table. `approve_close` records the D20 supervisor approval without changing status. */
export const TRANSITIONS: Readonly<
  Record<
    WorkOrderCommand,
    { readonly from: readonly WorkOrderStatus[]; readonly to: WorkOrderStatus }
  >
> = {
  assign: { from: ['scheduled'], to: 'assigned' },
  start: { from: ['assigned'], to: 'in_progress' },
  complete: { from: ['in_progress'], to: 'completed' },
  approve_close: { from: ['completed'], to: 'completed' },
  close: { from: ['completed'], to: 'closed' },
  cancel: { from: ['scheduled', 'assigned', 'in_progress'], to: 'cancelled' },
  reopen: { from: ['closed'], to: 'in_progress' },
};

export function targetOf(command: WorkOrderCommand, order: WorkOrder): WorkOrderStatus {
  const rule = TRANSITIONS[command];
  if (!rule.from.includes(order.status)) throw new WorkOrderError('invalid_transition');
  return rule.to;
}

/** Statuses where work facts (tasks, parts, costs) may still change. */
export const EDITABLE_STATUSES: readonly WorkOrderStatus[] = [
  'scheduled',
  'assigned',
  'in_progress',
  'completed',
];
export const OPEN_STATUSES: readonly WorkOrderStatus[] = [
  'scheduled',
  'assigned',
  'in_progress',
  'completed',
];

/**
 * The caller as seen by this module. `permissions` are the session's effective grants; `mechanicIds`
 * are the active internal mechanics linked to the caller's membership (SPECS D9).
 */
export interface WorkOrderActor {
  readonly id: string;
  readonly subject: string;
  readonly permissions: readonly string[];
  readonly mechanicIds: readonly string[];
}

export const can = (actor: WorkOrderActor, permission: string): boolean =>
  actor.permissions.includes(permission);

/** A member linked to a mechanic and without fleet edit rights only reaches orders assigned to them. */
export const isMechanicScoped = (actor: WorkOrderActor): boolean =>
  !can(actor, 'edit') && actor.mechanicIds.length > 0;

export const isAssignedMechanic = (actor: WorkOrderActor, order: WorkOrder): boolean =>
  order.mechanicId !== null && actor.mechanicIds.includes(order.mechanicId);

export function canSee(actor: WorkOrderActor, order: WorkOrder): boolean {
  if (!can(actor, 'view')) return false;
  return !isMechanicScoped(actor) || isAssignedMechanic(actor, order);
}

/** Permission matrix per command; the caller must already see the order. */
export function requireCommand(
  actor: WorkOrderActor,
  command: WorkOrderCommand | 'work' | 'costs',
  order: WorkOrder,
): void {
  const fleet = can(actor, 'edit');
  const assigned = isAssignedMechanic(actor, order);
  const allowed: Record<typeof command, boolean> = {
    assign: fleet,
    start: fleet || assigned,
    complete: fleet || assigned,
    work: fleet || (assigned && order.status === 'in_progress'),
    costs: fleet && can(actor, 'view_costs'),
    approve_close: can(actor, 'approve'),
    close: fleet && can(actor, 'view_costs'),
    cancel: fleet,
    reopen: can(actor, 'reopen'),
  };
  if (!allowed[command]) throw new WorkOrderError('forbidden');
}

export function requireVersion(order: WorkOrder, expected: number): void {
  if (order.version !== expected) throw new WorkOrderError('stale_version');
}

export function missing(requirements: Readonly<Record<string, boolean>>): void {
  const absent = Object.entries(requirements)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  if (absent.length > 0) throw new WorkOrderError('missing_requirements', absent);
}
