/** Work order states of SPECS §6.1. Ids are English snake_case; Spanish labels belong to the web layer. */
export const WORK_ORDER_STATUSES = [
  'scheduled',
  'assigned',
  'in_progress',
  'completed',
  'closed',
  'cancelled',
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];
export type WorkOrderKind = 'preventive' | 'corrective';

/** Commands are the only way to change a status (no free PATCH of `status`). */
export const WORK_ORDER_COMMANDS = [
  'assign',
  'start',
  'complete',
  'approve_close',
  'close',
  'cancel',
  'reopen',
] as const;
export type WorkOrderCommand = (typeof WORK_ORDER_COMMANDS)[number];

/** Exact amount in the currency's minor unit, as a decimal string of digits, with its ISO 4217 code. */
export interface Money {
  readonly amountMinor: string;
  readonly currency: string;
}
export interface WorkOrderTask {
  readonly id: string;
  readonly description: string;
}
export interface WorkOrderPart {
  readonly id: string;
  readonly name: string;
  /** Fixed precision decimal (up to three decimals). Parts are order records, never stock. */
  readonly quantity: string;
  readonly unitCost: Money | null;
}
export type CostCategory = 'labor' | 'parts' | 'external_service' | 'other';
export interface WorkOrderCost {
  readonly id: string;
  readonly category: CostCategory;
  readonly amount: Money;
}
export interface CloseApproval {
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export interface WorkOrder {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: WorkOrderKind;
  readonly vehicleId: string;
  /** Preventive orders keep the MNT-PLANS plan, occurrence and scheduled order identity (same id). */
  readonly planId: string | null;
  readonly occurrenceId: string | null;
  readonly status: WorkOrderStatus;
  readonly version: number;
  readonly description: string | null;
  readonly responsibleId: string | null;
  readonly workshopId: string | null;
  readonly mechanicId: string | null;
  readonly scheduledDate: string | null;
  readonly requiresWorkshop: boolean;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly actualDate: string | null;
  readonly actualKm: number | null;
  readonly tasks: readonly WorkOrderTask[];
  readonly parts: readonly WorkOrderPart[];
  readonly costs: readonly WorkOrderCost[];
  readonly closeApproval: CloseApproval | null;
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  /** Vehicle status chosen explicitly at closure; recorded, never applied automatically (D11). */
  readonly vehicleStatusDecision: string | null;
  readonly cancelReason: string | null;
  readonly reopenCount: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/** Immutable timeline entry; `before` keeps the facts a reopen or cancel invalidates. */
export interface WorkOrderTransition {
  readonly tenantId: string;
  readonly orderId: string;
  readonly sequence: number;
  readonly command: WorkOrderCommand | 'create';
  readonly from: WorkOrderStatus | null;
  readonly to: WorkOrderStatus;
  readonly actorId: string;
  readonly comment: string | null;
  readonly occurredAt: string;
  readonly before: Readonly<Record<string, unknown>> | null;
}

/** Outbox events of this module. Payloads are allowlisted before persistence. */
export const WORK_ORDER_STATUS_CHANGED_EVENT = 'maintenance.status_changed';
export const WORK_ORDER_CREATED_EVENT = 'maintenance.created';
/** Accepted MNT-PLANS port: consumed by the plans worker to advance the occurrence once. */
export const PREVENTIVE_ORDER_CLOSED_EVENT = 'maintenance.order.preventive_closed';
/** Plans-side lifecycle ports (ids and order version only): reopen invalidates the closure, cancel frees the plan. */
export const PREVENTIVE_ORDER_REOPENED_EVENT = 'maintenance.order.preventive_reopened';
export const PREVENTIVE_ORDER_CANCELLED_EVENT = 'maintenance.order.preventive_cancelled';
export const PREVENTIVE_ORDER_ADOPTED_EVENT = 'maintenance.order.preventive_adopted';

export interface WorkOrderEvent {
  readonly type: string;
  readonly payload: Readonly<Record<string, string | number>>;
}

/** One atomic write: order row, timeline entry, local audit and outbox in one tenant transaction. */
export interface WorkOrderMutation {
  readonly order: WorkOrder;
  /** `null` for a new order; otherwise the version the write is conditional on. */
  readonly expectedVersion: number | null;
  readonly transition: WorkOrderTransition | null;
  readonly auditAction: string;
  readonly events: readonly WorkOrderEvent[];
}

export interface WorkOrderStore {
  /** Applies the mutation atomically; returns false on a stale version (nothing written). */
  apply(mutation: WorkOrderMutation): Promise<boolean>;
  get(tenantId: string, id: string): Promise<WorkOrder | null>;
  list(
    tenantId: string,
    filter?: { readonly mechanicIds?: readonly string[] },
  ): Promise<readonly WorkOrder[]>;
  history(tenantId: string, id: string): Promise<readonly WorkOrderTransition[]>;
  /** Open orders of the vehicle that hold it in a workshop (eligibility blocks of this module). */
  openWorkshopOrders(tenantId: string, vehicleId: string): Promise<readonly WorkOrder[]>;
}

/** Scheduled order generated by MNT-PLANS (read through its accepted schedule reader). */
export interface PlanScheduledOrderRef {
  readonly id: string;
  readonly occurrenceId: string;
  readonly planId: string;
  readonly vehicleId: string;
  readonly status: 'scheduled' | 'completed' | 'closed' | 'cancelled';
  readonly workshopId: string | null;
  readonly mechanicId: string | null;
}
export interface PlanServiceBaseline {
  readonly lastServiceDate: string | null;
  readonly lastServiceKm: number | null;
}

export interface WorkOrderReferences {
  vehicleExists(tenantId: string, vehicleId: string): Promise<boolean>;
  isTenantMember(tenantId: string, memberId: string): Promise<boolean>;
  workshop(tenantId: string, id: string): Promise<{ readonly active: boolean } | null>;
  mechanic(
    tenantId: string,
    id: string,
  ): Promise<{
    readonly active: boolean;
    readonly workshopId: string | null;
    readonly memberId: string | null;
  } | null>;
  /** Active internal mechanics linked to the member (mechanic identity of SPECS D9). */
  mechanicIdsOfMember(tenantId: string, memberId: string): Promise<readonly string[]>;
  scheduledOrder(
    tenantId: string,
    planId: string,
    orderId: string,
  ): Promise<PlanScheduledOrderRef | null>;
  /**
   * Service baseline of the plan excluding the closure of `occurrenceId` (when that closure is still
   * applied), so a reopened order is validated against the baseline that existed before its first close.
   */
  planBaseline(
    tenantId: string,
    planId: string,
    occurrenceId: string | null,
  ): Promise<PlanServiceBaseline | null>;
  /** SPECS D20: true only when the tenant configured a costly-closure threshold. */
  closeApprovalRequired(tenantId: string): Promise<boolean>;
}
