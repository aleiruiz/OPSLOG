import { randomUUID } from 'node:crypto';
import { WorkOrderError } from './errors.js';
import { IDEMPOTENCY_TTL_MS, type IdempotencyClaim } from './idempotency.js';
import { opaqueId, version } from './rules.js';
import {
  WORK_ORDER_CREATED_EVENT,
  WORK_ORDER_STATUS_CHANGED_EVENT,
  type WorkOrder,
  type WorkOrderCommand,
  type WorkOrderEvent,
  type WorkOrderFileCommand,
  type WorkOrderReferences,
  type WorkOrderStore,
  type WorkOrderTransition,
} from './types.js';
import {
  EDITABLE_STATUSES,
  canSee,
  isMechanicScoped,
  requireCommand,
  requireVersion,
  targetOf,
  type WorkOrderActor,
} from './workflow.js';

export interface WorkOrderServiceOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** How long a recorded Idempotency-Key stays valid (default 24 h). */
  readonly idempotencyTtlMs?: number;
}

const BEFORE_FIELDS = [
  'status',
  'closeApproval',
  'closedAt',
  'closedBy',
  'vehicleStatusDecision',
  'completedAt',
  'actualDate',
  'actualKm',
  'tasks',
  'parts',
  'costs',
] as const;

/** Shared reads and the atomic write path (CAS, timeline, audit, outbox) of the work order service. */
export abstract class WorkOrderServiceBase {
  protected readonly now: () => Date;
  protected readonly newId: () => string;
  protected readonly idempotencyTtlMs: number;
  public constructor(
    protected readonly store: WorkOrderStore,
    protected readonly refs: WorkOrderReferences,
    options: WorkOrderServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.idempotencyTtlMs = options.idempotencyTtlMs ?? IDEMPOTENCY_TTL_MS;
  }

  protected blank(
    actor: WorkOrderActor,
    tenantId: string,
    base: Pick<
      WorkOrder,
      | 'id'
      | 'kind'
      | 'vehicleId'
      | 'planId'
      | 'occurrenceId'
      | 'description'
      | 'workshopId'
      | 'mechanicId'
    >,
  ): WorkOrder {
    const time = this.now().toISOString();
    return {
      ...base,
      tenantId,
      status: 'scheduled',
      version: 1,
      responsibleId: null,
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
      createdAt: time,
      createdBy: actor.id,
      updatedAt: time,
      updatedBy: actor.id,
    };
  }

  protected async insert(
    actor: WorkOrderActor,
    order: WorkOrder,
    extra: readonly WorkOrderEvent[] = [],
    idempotency?: IdempotencyClaim,
  ): Promise<WorkOrder> {
    const created = await this.store.apply({
      order,
      expectedVersion: null,
      transition: this.timeline(order, 'create', null, actor, null, null),
      auditAction: 'maintenance.work_order.created',
      events: [this.event(WORK_ORDER_CREATED_EVENT, order), ...extra],
      ...(idempotency ? { idempotency } : {}),
    });
    if (!created) throw new WorkOrderError('duplicate');
    return order;
  }

  public async get(tenantId: string, actor: WorkOrderActor, id: string): Promise<WorkOrder> {
    const order = await this.store.get(tenantId, opaqueId(id));
    if (!order || !canSee(actor, order)) throw new WorkOrderError('not_found');
    return order;
  }

  public async list(tenantId: string, actor: WorkOrderActor): Promise<readonly WorkOrder[]> {
    if (!actor.permissions.includes('view')) throw new WorkOrderError('forbidden');
    const orders = isMechanicScoped(actor)
      ? await this.store.list(tenantId, { mechanicIds: actor.mechanicIds })
      : await this.store.list(tenantId);
    return orders.filter((order) => canSee(actor, order));
  }

  public async history(
    tenantId: string,
    actor: WorkOrderActor,
    id: string,
  ): Promise<readonly WorkOrderTransition[]> {
    const order = await this.get(tenantId, actor, id);
    return this.store.history(tenantId, order.id);
  }

  protected async edit(
    order: WorkOrder,
    actor: WorkOrderActor,
    expected: number,
    changes: Partial<WorkOrder>,
    auditAction: string,
  ): Promise<WorkOrder> {
    if (!EDITABLE_STATUSES.includes(order.status)) throw new WorkOrderError('invalid_transition');
    requireVersion(order, expected);
    const next: WorkOrder = {
      ...order,
      ...changes,
      // A D20 approval covers the facts it saw: any later edit of a completed order needs a new one.
      ...(order.status === 'completed' ? { closeApproval: null } : {}),
      version: order.version + 1,
      updatedAt: this.now().toISOString(),
      updatedBy: actor.id,
    };
    if (
      !(await this.store.apply({
        order: next,
        expectedVersion: order.version,
        transition: null,
        auditAction,
        events: [],
      }))
    )
      throw new WorkOrderError('stale_version');
    return next;
  }

  protected async prepare(
    tenantId: string,
    actor: WorkOrderActor,
    id: string,
    command: WorkOrderCommand,
    expected: unknown,
  ): Promise<WorkOrder> {
    const order = await this.get(tenantId, actor, id);
    requireCommand(actor, command, order);
    const expectedVersion = version(expected);
    targetOf(command, order);
    requireVersion(order, expectedVersion);
    return order;
  }

  protected async transition(
    order: WorkOrder,
    actor: WorkOrderActor,
    command: WorkOrderCommand,
    changes: Partial<WorkOrder>,
    comment: string | null,
    extra: readonly WorkOrderEvent[] = [],
    idempotency?: IdempotencyClaim,
  ): Promise<WorkOrder> {
    const to = targetOf(command, order);
    const next: WorkOrder = {
      ...order,
      ...changes,
      status: to,
      version: order.version + 1,
      updatedAt: this.now().toISOString(),
      updatedBy: actor.id,
    };
    const applied = await this.store.apply({
      order: next,
      expectedVersion: order.version,
      transition: this.timeline(next, command, order, actor, comment, order),
      auditAction: `maintenance.work_order.${command}`,
      events: [this.event(WORK_ORDER_STATUS_CHANGED_EVENT, next), ...extra],
      ...(idempotency ? { idempotency } : {}),
    });
    if (!applied) throw new WorkOrderError('stale_version');
    return next;
  }

  protected timeline(
    order: WorkOrder,
    command: WorkOrderCommand | WorkOrderFileCommand | 'create',
    previous: WorkOrder | null,
    actor: WorkOrderActor,
    comment: string | null,
    before: WorkOrder | null,
  ): WorkOrderTransition {
    return {
      tenantId: order.tenantId,
      orderId: order.id,
      sequence: order.version,
      command,
      from: previous?.status ?? null,
      to: order.status,
      actorId: actor.id,
      comment,
      occurredAt: order.updatedAt,
      before: before
        ? Object.fromEntries(BEFORE_FIELDS.map((field) => [field, before[field]]))
        : null,
    };
  }

  protected event(type: string, order: WorkOrder): WorkOrderEvent {
    return {
      type,
      payload: { orderId: order.id, vehicleId: order.vehicleId, version: order.version },
    };
  }
}
