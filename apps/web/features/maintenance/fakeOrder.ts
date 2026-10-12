import type { BffWorkOrder, BffWorkOrderTransitionInput } from '@opslog/contracts';

const at = '2026-10-12T12:00:00.000Z';

/** A synthetic corrective order in `scheduled`, for tests and stories. */
export function baseOrder(overrides: Partial<BffWorkOrder> = {}): BffWorkOrder {
  return {
    id: 'wo-1',
    kind: 'corrective',
    vehicleId: 'veh-001',
    planId: null,
    occurrenceId: null,
    status: 'scheduled',
    version: 1,
    description: 'Frenos rechinan',
    responsibleId: null,
    workshopId: null,
    mechanicId: null,
    scheduledDate: null,
    requiresWorkshop: false,
    startedAt: null,
    completedAt: null,
    actualDate: null,
    actualKm: null,
    tasks: [],
    parts: [],
    costs: [],
    closeApproval: null,
    closedAt: null,
    closedBy: null,
    vehicleStatusDecision: null,
    cancelReason: null,
    reopenCount: 0,
    vehicleProposal: null,
    createdAt: at,
    createdBy: 'user-admin',
    updatedAt: at,
    updatedBy: 'user-admin',
    ...overrides,
  };
}

export const NEXT: Record<string, BffWorkOrder['status']> = {
  assign: 'assigned',
  start: 'in_progress',
  complete: 'completed',
  close: 'closed',
  cancel: 'cancelled',
  reopen: 'in_progress',
  approve_close: 'completed',
};

export function missingFor(
  order: BffWorkOrder,
  input: BffWorkOrderTransitionInput,
  approvalRequired: boolean,
) {
  const checks: Record<string, Record<string, boolean>> = {
    assign: {
      responsibleId: Boolean(input.responsibleId),
      scheduledDate: Boolean(input.scheduledDate),
      workshopOrMechanic: Boolean(input.workshopId ?? input.mechanicId),
    },
    complete: {
      actualDate: Boolean(input.actualDate),
      actualKm: input.actualKm !== undefined,
      tasks: order.tasks.length > 0,
    },
    close: {
      tasks: order.tasks.length > 0,
      vehicleStatus: Boolean(input.vehicleStatus),
      closeApproval: !approvalRequired || order.closeApproval !== null,
    },
    cancel: { reason: Boolean(input.reason) },
    reopen: { reason: Boolean(input.reason) },
  };
  return Object.entries(checks[input.command] ?? {})
    .filter(([, present]) => !present)
    .map(([name]) => name);
}
