import type {
  WorkOrderAttachment,
  WorkOrder,
  WorkOrderCost,
  WorkOrderPart,
  WorkOrderTask,
  WorkOrderTransition,
} from '../../../../domain/maintenance/orders/src/index.js';
import type {
  WorkOrderFileEntity,
  WorkOrderCostEntity,
  WorkOrderEntity,
  WorkOrderPartEntity,
  WorkOrderTaskEntity,
  WorkOrderTransitionEntity,
} from './entities.js';

const iso = (value: Date | null) => (value ? value.toISOString() : null);
const date = (value: string | null) => (value ? new Date(value) : null);
/** DECIMAL(10,3) comes back as `1.500`; the domain keeps the shortest exact form. */
const quantity = (value: string) =>
  value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;

export function orderRow(order: WorkOrder): WorkOrderEntity {
  return {
    tenantId: order.tenantId,
    id: order.id,
    kind: order.kind,
    vehicleId: order.vehicleId,
    planId: order.planId,
    occurrenceId: order.occurrenceId,
    status: order.status,
    version: order.version,
    description: order.description,
    responsibleId: order.responsibleId,
    workshopId: order.workshopId,
    mechanicId: order.mechanicId,
    scheduledDate: order.scheduledDate,
    requiresWorkshop: order.requiresWorkshop,
    startedAt: date(order.startedAt),
    completedAt: date(order.completedAt),
    actualDate: order.actualDate,
    actualKm: order.actualKm,
    closeApprovedBy: order.closeApproval?.approvedBy ?? null,
    closeApprovedAt: date(order.closeApproval?.approvedAt ?? null),
    closedAt: date(order.closedAt),
    closedBy: order.closedBy,
    vehicleStatusDecision: order.vehicleStatusDecision,
    cancelReason: order.cancelReason,
    reopenCount: order.reopenCount,
    createdAt: new Date(order.createdAt),
    createdBy: order.createdBy,
    updatedAt: new Date(order.updatedAt),
    updatedBy: order.updatedBy,
  };
}

export function childRows(order: WorkOrder) {
  const owner = { tenantId: order.tenantId, orderId: order.id };
  return {
    tasks: order.tasks.map(
      (task, position): WorkOrderTaskEntity => ({
        ...owner,
        id: task.id,
        position,
        description: task.description,
      }),
    ),
    parts: order.parts.map(
      (part, position): WorkOrderPartEntity => ({
        ...owner,
        id: part.id,
        position,
        name: part.name,
        quantity: part.quantity,
        unitCostMinor: part.unitCost?.amountMinor ?? null,
        unitCostCurrency: part.unitCost?.currency ?? null,
      }),
    ),
    costs: order.costs.map(
      (cost, position): WorkOrderCostEntity => ({
        ...owner,
        id: cost.id,
        position,
        category: cost.category,
        amountMinor: cost.amount.amountMinor,
        currency: cost.amount.currency,
      }),
    ),
  };
}

export function orderFrom(
  row: WorkOrderEntity,
  tasks: readonly WorkOrderTaskEntity[],
  parts: readonly WorkOrderPartEntity[],
  costs: readonly WorkOrderCostEntity[],
): WorkOrder {
  const byPosition = <T extends { readonly position: number }>(items: readonly T[]) =>
    [...items].sort((a, b) => a.position - b.position);
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind as WorkOrder['kind'],
    vehicleId: row.vehicleId,
    planId: row.planId,
    occurrenceId: row.occurrenceId,
    status: row.status as WorkOrder['status'],
    version: row.version,
    description: row.description,
    responsibleId: row.responsibleId,
    workshopId: row.workshopId,
    mechanicId: row.mechanicId,
    scheduledDate: row.scheduledDate,
    requiresWorkshop: Boolean(row.requiresWorkshop),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    actualDate: row.actualDate,
    actualKm: row.actualKm,
    tasks: byPosition(tasks).map(
      (task): WorkOrderTask => ({ id: task.id, description: task.description }),
    ),
    parts: byPosition(parts).map(
      (part): WorkOrderPart => ({
        id: part.id,
        name: part.name,
        quantity: quantity(part.quantity),
        unitCost:
          part.unitCostMinor === null || part.unitCostCurrency === null
            ? null
            : { amountMinor: String(part.unitCostMinor), currency: part.unitCostCurrency },
      }),
    ),
    costs: byPosition(costs).map(
      (cost): WorkOrderCost => ({
        id: cost.id,
        category: cost.category as WorkOrderCost['category'],
        amount: { amountMinor: String(cost.amountMinor), currency: cost.currency },
      }),
    ),
    closeApproval:
      row.closeApprovedBy && row.closeApprovedAt
        ? { approvedBy: row.closeApprovedBy, approvedAt: row.closeApprovedAt.toISOString() }
        : null,
    closedAt: iso(row.closedAt),
    closedBy: row.closedBy,
    vehicleStatusDecision: row.vehicleStatusDecision,
    cancelReason: row.cancelReason,
    reopenCount: row.reopenCount,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

export function transitionRow(value: WorkOrderTransition): WorkOrderTransitionEntity {
  return {
    tenantId: value.tenantId,
    orderId: value.orderId,
    sequence: value.sequence,
    command: value.command,
    fromStatus: value.from,
    toStatus: value.to,
    actorId: value.actorId,
    comment: value.comment,
    occurredAt: new Date(value.occurredAt),
    before: value.before ? { ...value.before } : null,
  };
}

export function transitionFrom(row: WorkOrderTransitionEntity): WorkOrderTransition {
  return {
    tenantId: row.tenantId,
    orderId: row.orderId,
    sequence: row.sequence,
    command: row.command as WorkOrderTransition['command'],
    from: row.fromStatus as WorkOrderTransition['from'],
    to: row.toStatus as WorkOrderTransition['to'],
    actorId: row.actorId,
    comment: row.comment,
    occurredAt: row.occurredAt.toISOString(),
    before: (row.before as WorkOrderTransition['before']) ?? null,
  };
}

export function fileRow(value: WorkOrderAttachment): WorkOrderFileEntity {
  return {
    tenantId: value.tenantId,
    orderId: value.orderId,
    id: value.id,
    fileId: value.fileId,
    kind: value.kind,
    displayName: value.displayName,
    contentType: value.contentType,
    sizeBytes: value.sizeBytes,
    attachedBy: value.attachedBy,
    attachedAt: new Date(value.attachedAt),
  };
}

export function fileFrom(row: WorkOrderFileEntity): WorkOrderAttachment {
  return {
    id: row.id,
    tenantId: row.tenantId,
    orderId: row.orderId,
    fileId: row.fileId,
    kind: row.kind as WorkOrderAttachment['kind'],
    displayName: row.displayName,
    contentType: row.contentType,
    sizeBytes: Number(row.sizeBytes),
    attachedBy: row.attachedBy,
    attachedAt: row.attachedAt.toISOString(),
  };
}
