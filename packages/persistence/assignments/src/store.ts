import 'reflect-metadata';
import { IsNull, type DataSource, type EntityManager, type FindOptionsWhere } from 'typeorm';
import {
  AssignmentError,
  isAssignmentType,
  type Assignment,
  type AssignmentClosing,
  type AssignmentEvent,
  type AssignmentEventSlice,
  type AssignmentFilter,
  type AssignmentSlice,
  type AssignmentStore,
  type AssignmentWindow,
  type EndKind,
} from '../../../domain/assignments/src/index.js';
import { ASSIGNMENTS_RUNTIME_ACCOUNT } from './data-source.js';
import { appendLocalAuditAndDelivery, type AuditEvent } from '../../audit/src/index.js';
import { AssignmentEntity, AssignmentEventEntity } from './entities.js';
import {
  AssignmentStoreError,
  isDuplicateKey,
  isLockContention,
  sanitizeStoreError,
  type AssignmentStoreErrorCode,
} from './errors.js';

/** Structured report of a failed operation (operation name, coarse code, driver errno). */
export interface StoreErrorEvent {
  readonly operation: string;
  readonly code: AssignmentStoreErrorCode;
  readonly errno: number | null;
}

export interface TypeOrmAssignmentStoreOptions {
  /** Total attempts for a transaction that hits a deadlock or lock-wait timeout (default 3). */
  readonly maxAttempts?: number;
  readonly onError?: (event: StoreErrorEvent) => void;
}

const integrity = (): never => {
  throw new AssignmentStoreError('integrity');
};

const endKindOf = (value: string | null): EndKind | null =>
  value === null ? null : value === 'ended' || value === 'replaced' ? value : integrity();

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const toAssignment = (row: AssignmentEntity): Assignment => ({
  id: row.id,
  tenantId: row.tenantId,
  vehicleId: row.vehicleId,
  employeeId: row.employeeId,
  type: isAssignmentType(row.type) ? row.type : integrity(),
  reason: row.reason,
  assignedBy: row.assignedBy,
  startedAt: row.startedAt.toISOString(),
  endedAt: iso(row.endedAt),
  endKind: endKindOf(row.endKind),
  endReason: row.endReason,
  endedBy: row.endedBy,
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
});

const toEvent = (row: AssignmentEventEntity): AssignmentEvent => ({
  tenantId: row.tenantId,
  assignmentId: row.assignmentId,
  seq: row.seq,
  kind: row.kind === 'assigned' ? 'assigned' : (endKindOf(row.kind) ?? integrity()),
  actorId: row.actorId,
  reason: row.reason,
  at: row.at.toISOString(),
});

/**
 * Columns that can change after creation (never the tenant, the id, the vehicle, the driver, the
 * type, the reason or the start). The flags are derived here from the state: the keys that enforce
 * BR-002 / BR-003 can never disagree with the row.
 */
const mutableColumns = (assignment: Assignment) => ({
  endedAt: assignment.endedAt === null ? null : new Date(assignment.endedAt),
  endKind: assignment.endKind,
  endReason: assignment.endReason,
  endedBy: assignment.endedBy,
  currentFlag: assignment.endedAt === null ? 1 : null,
  principalFlag: assignment.endedAt === null && assignment.type === 'principal' ? 1 : null,
  version: assignment.version,
  updatedAt: new Date(assignment.updatedAt),
});

const toAssignmentRow = (assignment: Assignment): AssignmentEntity => ({
  tenantId: assignment.tenantId,
  id: assignment.id,
  vehicleId: assignment.vehicleId,
  employeeId: assignment.employeeId,
  type: assignment.type,
  reason: assignment.reason,
  assignedBy: assignment.assignedBy,
  startedAt: new Date(assignment.startedAt),
  ...mutableColumns(assignment),
});

const toEventRow = (event: AssignmentEvent): AssignmentEventEntity => ({
  tenantId: event.tenantId,
  assignmentId: event.assignmentId,
  seq: event.seq,
  kind: event.kind,
  actorId: event.actorId,
  reason: event.reason,
  at: new Date(event.at),
});

const auditEvent = (event: AssignmentEvent): AuditEvent => ({
  eventId: `${event.assignmentId}.${event.seq}`,
  tenantId: event.tenantId,
  action: `assignment.${event.kind}`,
  entityType: 'assignment',
  entityId: event.assignmentId,
  occurredAt: event.at,
  actor: { id: event.actorId, kind: 'user' },
  correlationId: `${event.assignmentId}.${event.seq}`,
  data: {},
});

/**
 * Persistent TypeORM/MySQL implementation of the `AssignmentStore` port.
 *
 * - Every statement names `company_id`: the primary key, every index and every filter start with
 *   it, so a row of another company is unreachable, not merely hidden.
 * - BR-002 / BR-003 are database constraints, not read-then-write checks: unique keys over the
 *   `current_flag` / `principal_flag` columns make a second current principal (per vehicle or per
 *   driver) or a second current (vehicle, driver) pair impossible even for concurrent writers. The
 *   losing writer gets `AssignmentError('principal_taken' | 'already_assigned', field)`.
 * - An assignment change and its event are one READ COMMITTED transaction (a replacement closes
 *   the old principal and opens the new one in a single transaction). Event rows are only inserted.
 * - Concurrency is optimistic: closing is a single conditional UPDATE on `(company_id, id, version)`.
 * - Driver errors never leave this class: everything becomes the sanitized `AssignmentStoreError`
 *   (no SQL, no parameters) except the two domain conflicts above.
 */
export class TypeOrmAssignmentStore implements AssignmentStore {
  private readonly maxAttempts: number;
  private readonly onError: ((event: StoreErrorEvent) => void) | undefined;

  public constructor(
    private readonly dataSource: DataSource,
    options: TypeOrmAssignmentStoreOptions = {},
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Assignment store requires MySQL with synchronize disabled');
    const username = dataSource.options.username;
    if (typeof username !== 'string' || !ASSIGNMENTS_RUNTIME_ACCOUNT.test(username))
      throw new Error('Assignment store requires its restricted runtime account');
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.onError = options.onError;
  }

  private fail(operation: string, error: unknown): Error {
    const safe = sanitizeStoreError(error);
    if (safe instanceof AssignmentStoreError)
      this.onError?.({ operation, code: safe.code, errno: safe.errno });
    return safe;
  }

  /** Which unique key a failed insert hit, named as the domain conflict it is. */
  private async conflictOf(
    operation: string,
    candidate: Assignment,
    replacedId: string | null,
  ): Promise<Error> {
    try {
      const repository = this.dataSource.getRepository(AssignmentEntity);
      const { tenantId, vehicleId, employeeId } = candidate;
      if (candidate.type === 'principal') {
        // The principal being replaced was rolled back with the failed transaction: it is not the culprit.
        const holder = await repository.findOneBy({ tenantId, vehicleId, principalFlag: 1 });
        if (holder && holder.id !== replacedId)
          return new AssignmentError('principal_taken', 'vehicle_id');
        if (await repository.findOneBy({ tenantId, employeeId, principalFlag: 1 }))
          return new AssignmentError('principal_taken', 'employee_id');
      }
      const pair = await repository.findOneBy({ tenantId, vehicleId, employeeId, currentFlag: 1 });
      if (pair && pair.id !== replacedId)
        return new AssignmentError('already_assigned', 'employee_id');
      // The holder is already gone: the writer can simply retry.
      return this.fail(operation, { driverError: { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' } });
    } catch (error) {
      return this.fail(operation, error);
    }
  }

  /** One READ COMMITTED transaction, retried only for deadlocks and lock-wait timeouts. */
  private async transaction<T>(
    operation: string,
    work: (manager: EntityManager) => Promise<T>,
    candidate?: { readonly assignment: Assignment; readonly replacedId: string | null },
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.dataSource.transaction('READ COMMITTED', work);
      } catch (error) {
        if (isLockContention(error) && attempt < this.maxAttempts) continue;
        if (candidate && isDuplicateKey(error))
          throw await this.conflictOf(operation, candidate.assignment, candidate.replacedId);
        throw this.fail(operation, error);
      }
    }
  }

  /** Statements outside a transaction (autocommit). */
  private async single<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw this.fail(operation, error);
    }
  }

  public async insert(
    assignment: Assignment,
    event: AssignmentEvent,
    closing?: AssignmentClosing,
  ): Promise<boolean> {
    return this.transaction(
      'insert',
      async (manager) => {
        if (closing) {
          const closed = await manager.getRepository(AssignmentEntity).update(
            {
              tenantId: closing.next.tenantId,
              id: closing.next.id,
              version: closing.expectedVersion,
            },
            mutableColumns(closing.next),
          );
          if (closed.affected !== 1) return false;
          await manager.getRepository(AssignmentEventEntity).insert(toEventRow(closing.event));
          await appendLocalAuditAndDelivery(manager, auditEvent(closing.event));
        }
        await manager.getRepository(AssignmentEntity).insert(toAssignmentRow(assignment));
        await manager.getRepository(AssignmentEventEntity).insert(toEventRow(event));
        await appendLocalAuditAndDelivery(manager, auditEvent(event));
        return true;
      },
      { assignment, replacedId: closing?.next.id ?? null },
    );
  }

  public async find(tenantId: string, id: string): Promise<Assignment | null> {
    return this.single('find', async () => {
      const row = await this.dataSource.getRepository(AssignmentEntity).findOneBy({ tenantId, id });
      return row ? toAssignment(row) : null;
    });
  }

  public async list(
    tenantId: string,
    filter: AssignmentFilter,
    window: AssignmentWindow,
  ): Promise<AssignmentSlice> {
    return this.single('list', async () => {
      const where: FindOptionsWhere<AssignmentEntity> = {
        tenantId,
        ...(filter.vehicleId === undefined ? {} : { vehicleId: filter.vehicleId }),
        ...(filter.employeeId === undefined ? {} : { employeeId: filter.employeeId }),
        ...(filter.type === undefined ? {} : { type: filter.type }),
        ...(filter.status === undefined
          ? {}
          : { currentFlag: filter.status === 'current' ? 1 : IsNull() }),
      };
      const [rows, total] = await this.dataSource.getRepository(AssignmentEntity).findAndCount({
        where,
        order: { startedAt: 'DESC', id: 'ASC' },
        take: window.limit,
        skip: window.offset,
      });
      return { items: rows.map(toAssignment), total };
    });
  }

  public async replace(
    next: Assignment,
    expectedVersion: number,
    event: AssignmentEvent,
  ): Promise<boolean> {
    return this.transaction('replace', async (manager) => {
      const result = await manager
        .getRepository(AssignmentEntity)
        .update(
          { tenantId: next.tenantId, id: next.id, version: expectedVersion },
          mutableColumns(next),
        );
      if (result.affected !== 1) return false;
      await manager.getRepository(AssignmentEventEntity).insert(toEventRow(event));
      await appendLocalAuditAndDelivery(manager, auditEvent(event));
      return true;
    });
  }

  public async events(
    tenantId: string,
    assignmentId: string,
    window: AssignmentWindow,
  ): Promise<AssignmentEventSlice> {
    return this.single('events', async () => {
      const [rows, total] = await this.dataSource
        .getRepository(AssignmentEventEntity)
        .findAndCount({
          where: { tenantId, assignmentId },
          order: { seq: 'DESC' },
          take: window.limit,
          skip: window.offset,
        });
      return { items: rows.map(toEvent), total };
    });
  }
}
