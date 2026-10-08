import 'reflect-metadata';
import {
  And,
  Between,
  IsNull,
  LessThan,
  LessThanOrEqual,
  MoreThan,
  MoreThanOrEqual,
  type DataSource,
  type EntityManager,
  type FindOptionsWhere,
} from 'typeorm';
import {
  isCoverageType,
  type Deductible,
  type Policy,
  type PolicyFilter,
  type PolicyRevision,
  type PolicyRevisionSlice,
  type PolicySlice,
  type PolicyStore,
  type PolicyWindow,
} from '../../../domain/insurance/src/index.js';
import { INSURANCE_RUNTIME_ACCOUNT } from './data-source.js';
import { appendLocalAuditAndDelivery, type AuditEvent } from '../../audit/src/index.js';
import { PolicyEntity, PolicyRevisionEntity } from './entities.js';
import {
  PolicyStoreError,
  isLockContention,
  sanitizeStoreError,
  type PolicyStoreErrorCode,
} from './errors.js';

/** Structured report of a failed operation (operation name, coarse code, driver errno). */
export interface StoreErrorEvent {
  readonly operation: string;
  readonly code: PolicyStoreErrorCode;
  readonly errno: number | null;
}

export interface TypeOrmPolicyStoreOptions {
  /** Total attempts for a transaction that hits a deadlock or lock-wait timeout (default 3). */
  readonly maxAttempts?: number;
  readonly onError?: (event: StoreErrorEvent) => void;
}

interface DeductibleColumns {
  readonly deductibleKind: string | null;
  readonly deductibleValue: number | string | null;
  readonly deductibleCurrency: string | null;
}

/** The three typed columns of a deductible; a combination the CHECK would refuse is corrupt data. */
function deductibleOf(row: DeductibleColumns): Deductible | null {
  if (row.deductibleKind === null) {
    if (row.deductibleValue !== null || row.deductibleCurrency !== null)
      throw new PolicyStoreError('integrity');
    return null;
  }
  // BIGINT comes back as a string; every stored value is far below 2^53.
  const value = row.deductibleValue === null ? NaN : Number(row.deductibleValue);
  if (!Number.isSafeInteger(value)) throw new PolicyStoreError('integrity');
  if (row.deductibleKind === 'amount' && row.deductibleCurrency !== null)
    return { kind: 'amount', amountMinor: value, currency: row.deductibleCurrency };
  if (row.deductibleKind === 'percent' && row.deductibleCurrency === null)
    return { kind: 'percent', basisPoints: value };
  throw new PolicyStoreError('integrity');
}

const deductibleColumns = (deductible: Deductible | null): DeductibleColumns =>
  deductible === null
    ? { deductibleKind: null, deductibleValue: null, deductibleCurrency: null }
    : deductible.kind === 'amount'
      ? {
          deductibleKind: 'amount',
          deductibleValue: deductible.amountMinor,
          deductibleCurrency: deductible.currency,
        }
      : {
          deductibleKind: 'percent',
          deductibleValue: deductible.basisPoints,
          deductibleCurrency: null,
        };

const coverageOf = (value: string): Policy['coverageType'] =>
  isCoverageType(value)
    ? value
    : (() => {
        throw new PolicyStoreError('integrity');
      })();

const toPolicy = (row: PolicyEntity): Policy => ({
  id: row.id,
  tenantId: row.tenantId,
  vehicleId: row.vehicleId,
  insurer: row.insurer,
  coverageNotes: row.coverageNotes,
  revision: row.revision,
  policyNumber: row.policyNumber,
  coverageType: coverageOf(row.coverageType),
  startsOn: row.startsOn,
  endsOn: row.endsOn,
  deductible: deductibleOf(row),
  version: row.version,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
});

const toRevision = (row: PolicyRevisionEntity): PolicyRevision => ({
  tenantId: row.tenantId,
  policyId: row.policyId,
  revision: row.revision,
  policyNumber: row.policyNumber,
  coverageType: coverageOf(row.coverageType),
  startsOn: row.startsOn,
  endsOn: row.endsOn,
  deductible: deductibleOf(row),
  actorId: row.actorId,
  at: row.at.toISOString(),
});

/** Columns that can change after creation (never the tenant, the id, the vehicle or `createdAt`). */
const mutableColumns = (policy: Policy) => ({
  insurer: policy.insurer,
  coverageNotes: policy.coverageNotes,
  revision: policy.revision,
  policyNumber: policy.policyNumber,
  coverageType: policy.coverageType,
  startsOn: policy.startsOn,
  endsOn: policy.endsOn,
  ...deductibleColumns(policy.deductible),
  version: policy.version,
  updatedAt: new Date(policy.updatedAt),
  archivedAt: policy.archivedAt === null ? null : new Date(policy.archivedAt),
});

const toPolicyRow = (policy: Policy): PolicyEntity => ({
  tenantId: policy.tenantId,
  id: policy.id,
  vehicleId: policy.vehicleId,
  createdAt: new Date(policy.createdAt),
  ...mutableColumns(policy),
});

const toRevisionRow = (revision: PolicyRevision): PolicyRevisionEntity => ({
  tenantId: revision.tenantId,
  policyId: revision.policyId,
  revision: revision.revision,
  policyNumber: revision.policyNumber,
  coverageType: revision.coverageType,
  startsOn: revision.startsOn,
  endsOn: revision.endsOn,
  ...deductibleColumns(revision.deductible),
  actorId: revision.actorId,
  at: new Date(revision.at),
});

const auditEvent = (revision: PolicyRevision): AuditEvent => ({
  eventId: `${revision.policyId}.revision.${revision.revision}`,
  tenantId: revision.tenantId,
  action: revision.revision === 1 ? 'insurance.created' : 'insurance.renewed',
  entityType: 'insurance_policy',
  entityId: revision.policyId,
  occurredAt: revision.at,
  actor: { id: revision.actorId, kind: 'user' },
  correlationId: `${revision.policyId}.revision.${revision.revision}`,
  data: {},
});

/** The `ends_on` condition of a derived status (see `matchesExpiry` in the domain). */
function expiryCondition(expiry: NonNullable<PolicyFilter['expiry']>) {
  if (expiry.status === 'expired') return LessThan(expiry.from);
  if (expiry.status === 'expiring') return Between(expiry.from, expiry.until);
  return MoreThan(expiry.until);
}

/**
 * Persistent TypeORM/MySQL implementation of the `PolicyStore` port.
 *
 * - Every statement names `company_id`: the primary key, every index and every filter start with
 *   it, so a row of another company is unreachable, not merely hidden.
 * - A policy change and its revision row are one READ COMMITTED transaction. Revision rows are
 *   only ever inserted: the original period and deductible are never rewritten.
 * - Concurrency is optimistic: `replace` is a single conditional UPDATE on
 *   `(company_id, id, version)`; of two writers holding the same version, exactly one affects a row.
 * - Driver errors never leave this class: everything becomes the sanitized `PolicyStoreError`
 *   (no SQL, no parameters).
 */
export class TypeOrmPolicyStore implements PolicyStore {
  private readonly maxAttempts: number;
  private readonly onError: ((event: StoreErrorEvent) => void) | undefined;

  public constructor(
    private readonly dataSource: DataSource,
    options: TypeOrmPolicyStoreOptions = {},
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Policy store requires MySQL with synchronize disabled');
    const username = dataSource.options.username;
    if (typeof username !== 'string' || !INSURANCE_RUNTIME_ACCOUNT.test(username))
      throw new Error('Policy store requires its restricted runtime account');
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.onError = options.onError;
  }

  private fail(operation: string, error: unknown): Error {
    const safe = sanitizeStoreError(error);
    if (safe instanceof PolicyStoreError)
      this.onError?.({ operation, code: safe.code, errno: safe.errno });
    return safe;
  }

  /** One READ COMMITTED transaction, retried only for deadlocks and lock-wait timeouts. */
  private async transaction<T>(
    operation: string,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.dataSource.transaction('READ COMMITTED', work);
      } catch (error) {
        if (isLockContention(error) && attempt < this.maxAttempts) continue;
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

  public async insert(policy: Policy, revision: PolicyRevision): Promise<void> {
    await this.transaction('insert', async (manager) => {
      await manager.getRepository(PolicyEntity).insert(toPolicyRow(policy));
      await manager.getRepository(PolicyRevisionEntity).insert(toRevisionRow(revision));
      await appendLocalAuditAndDelivery(manager, auditEvent(revision));
    });
  }

  public async find(tenantId: string, id: string): Promise<Policy | null> {
    return this.single('find', async () => {
      const row = await this.dataSource.getRepository(PolicyEntity).findOneBy({ tenantId, id });
      return row ? toPolicy(row) : null;
    });
  }

  public async list(
    tenantId: string,
    filter: PolicyFilter,
    window: PolicyWindow,
  ): Promise<PolicySlice> {
    return this.single('list', async () => {
      // The status and `coversOn` both bound `ends_on`: both conditions apply (AND).
      const ends = [
        ...(filter.expiry === undefined ? [] : [expiryCondition(filter.expiry)]),
        ...(filter.coversOn === undefined ? [] : [MoreThanOrEqual(filter.coversOn)]),
      ];
      const where: FindOptionsWhere<PolicyEntity> = {
        tenantId,
        ...(filter.vehicleId === undefined ? {} : { vehicleId: filter.vehicleId }),
        ...(filter.coverageType === undefined ? {} : { coverageType: filter.coverageType }),
        ...(ends.length === 0 ? {} : { endsOn: ends.length === 1 ? ends[0] : And(...ends) }),
        ...(filter.coversOn === undefined ? {} : { startsOn: LessThanOrEqual(filter.coversOn) }),
        ...(filter.includeArchived ? {} : { archivedAt: IsNull() }),
      };
      const [rows, total] = await this.dataSource.getRepository(PolicyEntity).findAndCount({
        where,
        order: { endsOn: 'ASC', id: 'ASC' },
        take: window.limit,
        skip: window.offset,
      });
      return { items: rows.map(toPolicy), total };
    });
  }

  public async replace(
    next: Policy,
    expectedVersion: number,
    revision?: PolicyRevision,
  ): Promise<boolean> {
    return this.transaction('replace', async (manager) => {
      const result = await manager
        .getRepository(PolicyEntity)
        .update(
          { tenantId: next.tenantId, id: next.id, version: expectedVersion },
          mutableColumns(next),
        );
      if (result.affected !== 1) return false;
      if (revision) {
        await manager.getRepository(PolicyRevisionEntity).insert(toRevisionRow(revision));
        await appendLocalAuditAndDelivery(manager, auditEvent(revision));
      }
      return true;
    });
  }

  public async revisions(
    tenantId: string,
    policyId: string,
    window: PolicyWindow,
  ): Promise<PolicyRevisionSlice> {
    return this.single('revisions', async () => {
      const [rows, total] = await this.dataSource.getRepository(PolicyRevisionEntity).findAndCount({
        where: { tenantId, policyId },
        order: { revision: 'DESC' },
        take: window.limit,
        skip: window.offset,
      });
      return { items: rows.map(toRevision), total };
    });
  }
}
