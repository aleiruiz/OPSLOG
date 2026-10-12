import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { In, LessThanOrEqual, type DataSource, type EntityManager } from 'typeorm';
import { appendLocalAuditAndDelivery, MySqlTenantOutboxStore } from '../../../audit/src/index.js';
import {
  validateWorkOrderEvent,
  type IdempotencyRecord,
  type WorkOrder,
  type WorkOrderAttachment,
  type WorkOrderCommand,
  type WorkOrderMutation,
  type WorkOrderStore,
  type WorkOrderTransition,
} from '../../../../domain/maintenance/orders/src/index.js';
import { WORK_ORDER_RUNTIME_ACCOUNT } from './data-source.js';
import {
  WorkOrderCostSchema,
  WorkOrderFileSchema,
  WorkOrderIdempotencySchema,
  WorkOrderPartSchema,
  WorkOrderSchema,
  WorkOrderTaskSchema,
  WorkOrderTransitionSchema,
} from './entities.js';
import {
  childRows,
  fileFrom,
  fileRow,
  idempotencyFrom,
  idempotencyRow,
  orderFrom,
  orderRow,
  transitionFrom,
  transitionRow,
} from './mapping.js';

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);

/**
 * Tenant is part of every selector. Each mutation commits the order (version CAS), its work facts,
 * the timeline entry, the local audit row and the allowlisted outbox events in one transaction.
 */
export class TypeOrmWorkOrderStore implements WorkOrderStore {
  private readonly outbox: MySqlTenantOutboxStore;
  public constructor(
    private readonly dataSource: DataSource,
    private readonly maxAttempts = 3,
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Work order store requires MySQL with synchronize disabled');
    if (
      typeof dataSource.options.username !== 'string' ||
      !WORK_ORDER_RUNTIME_ACCOUNT.test(dataSource.options.username)
    )
      throw new Error('Work order store requires the restricted maintenance runtime account');
    this.outbox = new MySqlTenantOutboxStore(
      () => [],
      () => this.dataSource,
      () => this.dataSource,
    );
  }

  private async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.dataSource.transaction('READ COMMITTED', work);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (
          attempt < this.maxAttempts &&
          (code === 'ER_LOCK_DEADLOCK' || code === 'ER_LOCK_WAIT_TIMEOUT')
        )
          continue;
        throw error;
      }
    }
  }

  public async apply(mutation: WorkOrderMutation): Promise<boolean> {
    const events = mutation.events.map(validateWorkOrderEvent);
    const { order } = mutation;
    try {
      return await this.transaction(async (manager) => {
        const orders = manager.getRepository(WorkOrderSchema);
        if (mutation.expectedVersion === null) {
          await orders.insert(orderRow(order));
        } else {
          const changed = await orders.update(
            { tenantId: order.tenantId, id: order.id, version: mutation.expectedVersion },
            orderRow(order),
          );
          if (changed.affected !== 1) return false;
          await this.clearChildren(manager, order);
        }
        const children = childRows(order);
        if (children.tasks.length)
          await manager.getRepository(WorkOrderTaskSchema).insert(children.tasks);
        if (children.parts.length)
          await manager.getRepository(WorkOrderPartSchema).insert(children.parts);
        if (children.costs.length)
          await manager.getRepository(WorkOrderCostSchema).insert(children.costs);
        const change = mutation.file;
        if (change?.op === 'attach')
          await manager.getRepository(WorkOrderFileSchema).insert(fileRow(change.attachment));
        if (change?.op === 'detach') {
          const removed = await manager.getRepository(WorkOrderFileSchema).delete({
            tenantId: order.tenantId,
            orderId: order.id,
            id: change.attachmentId,
          });
          if (removed.affected !== 1) return false;
        }
        if (mutation.transition)
          await manager
            .getRepository(WorkOrderTransitionSchema)
            .insert(transitionRow(mutation.transition));
        await appendLocalAuditAndDelivery(manager, {
          eventId: `${order.id}.${digest(`${mutation.auditAction}|${order.version}`)}`,
          tenantId: order.tenantId,
          action: mutation.auditAction,
          entityType: 'maintenance_work_order',
          entityId: order.id,
          occurredAt: order.updatedAt,
          actor: { id: order.updatedBy, kind: 'user' },
          correlationId: `${order.id}.v${order.version}`,
          data: { attempts: 1 },
        });
        if (mutation.idempotency) {
          const idempotency = manager.getRepository(WorkOrderIdempotencySchema);
          const { actorId, command, key, createdAt } = mutation.idempotency;
          // An expired key of the same tuple is a new command; a live one trips the primary key.
          await idempotency.delete({
            tenantId: order.tenantId,
            actorId,
            command,
            key,
            expiresAt: LessThanOrEqual(new Date(createdAt)),
          });
          await idempotency.insert(idempotencyRow(order.tenantId, mutation.idempotency, order));
        }
        if (events.length)
          await this.outbox.transaction(manager, (tx) =>
            events.forEach((event, index) => {
              const eventId = `mnt-wo-${digest(`${order.tenantId}|${order.id}|${order.version}|${index}`)}`;
              tx.enqueue({
                eventId,
                tenantId: order.tenantId,
                type: event.type,
                payload: event.payload,
                occurredAt: order.updatedAt,
                idempotencyKey: eventId,
                correlationId: `${order.id}.v${order.version}`,
                actorRef: { subject: order.updatedBy, kind: 'user' },
                requiredPermission: 'view',
                entityId: order.id,
                schemaVersion: 1,
              });
            }),
          );
        return true;
      });
    } catch (error) {
      // A duplicate key is a lost creation race, or a file already linked (the unique link per file).
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return false;
      throw error;
    }
  }

  private async clearChildren(manager: EntityManager, order: WorkOrder): Promise<void> {
    const where = { tenantId: order.tenantId, orderId: order.id };
    await manager.getRepository(WorkOrderTaskSchema).delete(where);
    await manager.getRepository(WorkOrderPartSchema).delete(where);
    await manager.getRepository(WorkOrderCostSchema).delete(where);
  }

  private async hydrate(
    tenantId: string,
    rows: readonly ReturnType<typeof orderRow>[],
  ): Promise<WorkOrder[]> {
    if (rows.length === 0) return [];
    const where = { tenantId, orderId: In(rows.map((row) => row.id)) };
    const [tasks, parts, costs] = await Promise.all([
      this.dataSource.getRepository(WorkOrderTaskSchema).find({ where }),
      this.dataSource.getRepository(WorkOrderPartSchema).find({ where }),
      this.dataSource.getRepository(WorkOrderCostSchema).find({ where }),
    ]);
    return rows.map((row) =>
      orderFrom(
        row,
        tasks.filter((task) => task.orderId === row.id),
        parts.filter((part) => part.orderId === row.id),
        costs.filter((cost) => cost.orderId === row.id),
      ),
    );
  }

  public async get(tenantId: string, id: string): Promise<WorkOrder | null> {
    const row = await this.dataSource.getRepository(WorkOrderSchema).findOneBy({ tenantId, id });
    return row ? ((await this.hydrate(tenantId, [row]))[0] ?? null) : null;
  }

  public async list(
    tenantId: string,
    filter: { readonly mechanicIds?: readonly string[] } = {},
  ): Promise<readonly WorkOrder[]> {
    if (filter.mechanicIds && filter.mechanicIds.length === 0) return [];
    const rows = await this.dataSource.getRepository(WorkOrderSchema).find({
      where: filter.mechanicIds
        ? { tenantId, mechanicId: In([...filter.mechanicIds]) }
        : { tenantId },
      order: { createdAt: 'DESC', id: 'ASC' },
      take: 500,
    });
    return this.hydrate(tenantId, rows);
  }

  public async history(tenantId: string, id: string): Promise<readonly WorkOrderTransition[]> {
    const rows = await this.dataSource
      .getRepository(WorkOrderTransitionSchema)
      .find({ where: { tenantId, orderId: id }, order: { sequence: 'ASC' } });
    return rows.map(transitionFrom);
  }

  public async idempotency(
    tenantId: string,
    actorId: string,
    command: WorkOrderCommand,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const row = await this.dataSource
      .getRepository(WorkOrderIdempotencySchema)
      .findOneBy({ tenantId, actorId, command, key });
    return row ? idempotencyFrom(row) : null;
  }

  public async attachments(
    tenantId: string,
    orderId: string,
  ): Promise<readonly WorkOrderAttachment[]> {
    const rows = await this.dataSource
      .getRepository(WorkOrderFileSchema)
      .find({ where: { tenantId, orderId }, order: { attachedAt: 'ASC', id: 'ASC' } });
    return rows.map(fileFrom);
  }

  public async openWorkshopOrders(
    tenantId: string,
    vehicleId: string,
  ): Promise<readonly WorkOrder[]> {
    const rows = await this.dataSource.getRepository(WorkOrderSchema).find({
      where: {
        tenantId,
        vehicleId,
        requiresWorkshop: true,
        status: In(['in_progress', 'completed']),
      },
      order: { id: 'ASC' },
    });
    return this.hydrate(tenantId, rows);
  }
}
