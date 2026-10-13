import type { IdempotencyClaim, IdempotencyRecord } from './idempotency.js';

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

/** Typed files of a work order (SPECS:44/:348/:227): photos or documents of the work, and the supplier invoice. */
export const WORK_ORDER_FILE_KINDS = ['evidence', 'invoice'] as const;
export type WorkOrderFileKind = (typeof WORK_ORDER_FILE_KINDS)[number];
/** Timeline entries of file changes; they keep the order status and carry only the kind in the name. */
export const WORK_ORDER_FILE_COMMANDS = [
  'evidence_attached',
  'evidence_detached',
  'invoice_attached',
  'invoice_detached',
] as const;
export type WorkOrderFileCommand = (typeof WORK_ORDER_FILE_COMMANDS)[number];

/** Link between an order and a file of the files module. No bytes, hashes or storage keys live here. */
export interface WorkOrderAttachment {
  readonly id: string;
  readonly tenantId: string;
  readonly orderId: string;
  readonly fileId: string;
  readonly kind: WorkOrderFileKind;
  readonly displayName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly attachedBy: string;
  readonly attachedAt: string;
}
export type WorkOrderFileChange =
  | { readonly op: 'attach'; readonly attachment: WorkOrderAttachment }
  | { readonly op: 'detach'; readonly attachmentId: string };

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
  readonly command: WorkOrderCommand | WorkOrderFileCommand | 'create';
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
  /** A file link added or removed in the same transaction (the order version still moves on). */
  readonly file?: WorkOrderFileChange;
  /** Idempotency key of the command, recorded with `order` as its response in the same transaction. */
  readonly idempotency?: IdempotencyClaim;
}

export interface WorkOrderStore {
  /** Applies the mutation atomically; returns false on a stale version or a taken key (nothing written). */
  apply(mutation: WorkOrderMutation): Promise<boolean>;
  get(tenantId: string, id: string): Promise<WorkOrder | null>;
  list(
    tenantId: string,
    filter?: { readonly mechanicIds?: readonly string[] },
  ): Promise<readonly WorkOrder[]>;
  history(tenantId: string, id: string): Promise<readonly WorkOrderTransition[]>;
  /** The stored key of the (tenant, actor, command, key), expired or not; null when unknown. */
  idempotency(
    tenantId: string,
    actorId: string,
    command: WorkOrderCommand,
    key: string,
  ): Promise<IdempotencyRecord | null>;
  /** Files linked to the order, oldest first. */
  attachments(tenantId: string, orderId: string): Promise<readonly WorkOrderAttachment[]>;
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
  /** IANA zone of the tenant: "today" and calendar dates of the order are computed in it (SPECS:184). */
  timeZone(tenantId: string): Promise<string>;
  /**
   * Optional (incidents, D11): whether an open incident that says the vehicle cannot operate holds
   * the vehicle, so closing an order cannot return it to `active`. Absent, nothing changes. A read
   * that fails is an error, never "free".
   */
  vehicleBlocks?(tenantId: string, vehicleId: string): Promise<boolean>;
  /** Evidence and invoice the tenant requires before completing and closing (default: none). */
  fileRequirements(tenantId: string): Promise<WorkOrderFileRequirements>;
  /** The record of a file of the files module, tenant-scoped; null when it is unknown for the tenant. */
  fileRecord(tenantId: string, fileId: string): Promise<WorkOrderFileRecord | null>;
}

export interface WorkOrderFileRequirements {
  readonly evidence: boolean;
  readonly invoice: boolean;
}
export type WorkOrderFileStatus = 'pending_upload' | 'pending_scan' | 'clean' | 'rejected';
/** What this module needs to know of a file: only a `clean` one is persisted, released evidence. */
export interface WorkOrderFileRecord {
  readonly id: string;
  readonly status: WorkOrderFileStatus;
  readonly kind: 'original' | 'derivative';
  readonly sensitivity: 'standard' | 'pii';
  readonly createdBy: string;
  readonly displayName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}
