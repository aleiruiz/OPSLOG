import 'reflect-metadata';
import { IsNull, Not, type DataSource, type EntityManager } from 'typeorm';
import {
  EmployeeError,
  employeeNumberKey,
  isEmployeeKind,
  isEmployeeStatus,
  nameKey,
  type Employee,
  type EmployeeConflictField,
  type EmployeeFilter,
  type EmployeeHistoryEntry,
  type EmployeeHistorySlice,
  type EmployeeSlice,
  type EmployeeStore,
  type EmployeeWindow,
  type SealedField,
} from '../../../domain/employees/src/index.js';
import { EMPLOYEES_RUNTIME_ACCOUNT } from './data-source.js';
import { EmployeeEntity, EmployeeHistoryEntity } from './entities.js';
import {
  EmployeeStoreError,
  isDuplicateKey,
  isLockContention,
  sanitizeStoreError,
  type EmployeeStoreErrorCode,
} from './errors.js';

/** Structured, PII-free report of a failed operation (operation name, coarse code, driver errno). */
export interface StoreErrorEvent {
  readonly operation: string;
  readonly code: EmployeeStoreErrorCode;
  readonly errno: number | null;
}

export interface TypeOrmEmployeeStoreOptions {
  /** Total attempts for a transaction that hits a deadlock or lock-wait timeout (default 3). */
  readonly maxAttempts?: number;
  readonly onError?: (event: StoreErrorEvent) => void;
}

/** A sealed column and its index column must both be set or both be null; anything else is corrupt. */
function sealedOf(enc: string | null, idx: string | null, indexed: boolean): SealedField | null {
  if (enc === null) {
    if (idx !== null) throw new EmployeeStoreError('integrity');
    return null;
  }
  if (indexed === (idx === null)) throw new EmployeeStoreError('integrity');
  return { sealed: enc, index: idx };
}

const toEmployee = (row: EmployeeEntity): Employee => {
  if (!isEmployeeKind(row.kind) || !isEmployeeStatus(row.status))
    throw new EmployeeStoreError('integrity');
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    firstName: row.firstName,
    lastName: row.lastName,
    employeeNumber: row.employeeNumber,
    position: row.position,
    hireDate: row.hireDate,
    areaId: row.areaId,
    status: row.status,
    statusReason: row.statusReason,
    idType: row.idType,
    licenseType: row.licenseType,
    licenseExpiresOn: row.licenseExpiresOn,
    pii: {
      nationalId: sealedOf(row.nationalIdEnc, row.nationalIdIdx, true),
      phone: sealedOf(row.phoneEnc, null, false),
      email: sealedOf(row.emailEnc, row.emailIdx, true),
      licenseNumber: sealedOf(row.licenseNumberEnc, row.licenseNumberIdx, true),
    },
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
  };
};

const toEntry = (row: EmployeeHistoryEntity): EmployeeHistoryEntry => {
  if (row.kind !== 'status' && row.kind !== 'area') throw new EmployeeStoreError('integrity');
  return {
    id: row.id,
    tenantId: row.tenantId,
    employeeId: row.employeeId,
    kind: row.kind,
    from: row.fromValue,
    to: row.toValue,
    reason: row.reason,
    actorId: row.actorId,
    version: row.version,
    at: row.at.toISOString(),
  };
};

const enc = (field: SealedField | null): string | null => field?.sealed ?? null;
const idx = (field: SealedField | null): string | null => field?.index ?? null;

/** Columns that can change after creation (never the tenant, the id, the kind or `createdAt`). */
const mutableColumns = (employee: Employee) => ({
  firstName: employee.firstName,
  lastName: employee.lastName,
  nameKey: nameKey(employee.firstName, employee.lastName),
  employeeNumber: employee.employeeNumber,
  employeeNumberKey:
    employee.employeeNumber === null ? null : employeeNumberKey(employee.employeeNumber),
  position: employee.position,
  hireDate: employee.hireDate,
  areaId: employee.areaId,
  status: employee.status,
  statusReason: employee.statusReason,
  idType: employee.idType,
  nationalIdEnc: enc(employee.pii.nationalId),
  nationalIdIdx: idx(employee.pii.nationalId),
  phoneEnc: enc(employee.pii.phone),
  emailEnc: enc(employee.pii.email),
  emailIdx: idx(employee.pii.email),
  licenseNumberEnc: enc(employee.pii.licenseNumber),
  licenseNumberIdx: idx(employee.pii.licenseNumber),
  licenseType: employee.licenseType,
  licenseExpiresOn: employee.licenseExpiresOn,
  version: employee.version,
  updatedAt: new Date(employee.updatedAt),
  archivedAt: employee.archivedAt === null ? null : new Date(employee.archivedAt),
});

const toEmployeeRow = (employee: Employee): EmployeeEntity => ({
  tenantId: employee.tenantId,
  id: employee.id,
  kind: employee.kind,
  createdAt: new Date(employee.createdAt),
  ...mutableColumns(employee),
});

const toEntryRow = (entry: EmployeeHistoryEntry): EmployeeHistoryEntity => ({
  tenantId: entry.tenantId,
  id: entry.id,
  employeeId: entry.employeeId,
  kind: entry.kind,
  fromValue: entry.from,
  toValue: entry.to,
  reason: entry.reason,
  actorId: entry.actorId,
  version: entry.version,
  at: new Date(entry.at),
});

/**
 * Persistent TypeORM/MySQL implementation of the `EmployeeStore` port.
 *
 * - Every statement names `company_id`: the primary key, every unique key and every filter start
 *   with it, so a row of another company is unreachable, not merely hidden.
 * - An employee change and its history row are one READ COMMITTED transaction.
 * - Concurrency is optimistic: `replace` is a single conditional UPDATE on
 *   `(company_id, id, version)`; of two writers holding the same version, exactly one affects a row.
 * - Only sealed envelopes and blind indexes reach the database (the service seals before calling
 *   the store); the store never sees, logs or returns a plaintext value.
 * - Driver errors never leave this class: duplicates become `EmployeeError('duplicate', field)`,
 *   everything else the sanitized `EmployeeStoreError` (no SQL, no parameters).
 */
export class TypeOrmEmployeeStore implements EmployeeStore {
  private readonly maxAttempts: number;
  private readonly onError: ((event: StoreErrorEvent) => void) | undefined;

  public constructor(
    private readonly dataSource: DataSource,
    options: TypeOrmEmployeeStoreOptions = {},
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Employee store requires MySQL with synchronize disabled');
    const username = dataSource.options.username;
    if (typeof username !== 'string' || !EMPLOYEES_RUNTIME_ACCOUNT.test(username))
      throw new Error('Employee store requires its restricted runtime account');
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.onError = options.onError;
  }

  private fail(operation: string, error: unknown): Error {
    const safe = sanitizeStoreError(error);
    if (safe instanceof EmployeeStoreError)
      this.onError?.({ operation, code: safe.code, errno: safe.errno });
    return safe;
  }

  /**
   * One READ COMMITTED transaction, retried only for deadlocks and lock-wait timeouts. `candidate`
   * is the employee being written: a duplicate-key failure is answered by naming which key it hit.
   */
  private async transaction<T>(
    operation: string,
    candidate: Employee | null,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.dataSource.transaction('READ COMMITTED', work);
      } catch (error) {
        if (isLockContention(error) && attempt < this.maxAttempts) continue;
        throw await this.translate(operation, candidate, error);
      }
    }
  }

  /** Statements outside a transaction (autocommit). */
  private async single<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw await this.translate(operation, null, error);
    }
  }

  private async translate(
    operation: string,
    candidate: Employee | null,
    error: unknown,
  ): Promise<Error> {
    if (candidate && isDuplicateKey(error)) {
      try {
        const field = await this.conflictField(candidate);
        return new EmployeeError('duplicate', field);
      } catch (lookup) {
        return this.fail(operation, lookup);
      }
    }
    return this.fail(operation, error);
  }

  /** Names the unique key that was hit by looking the candidate up outside the failed transaction. */
  private async conflictField(candidate: Employee): Promise<EmployeeConflictField | undefined> {
    const repository = this.dataSource.getRepository(EmployeeEntity);
    const taken = async (
      where: { employeeNumberKey: string } | { nationalIdIdx: string } | { emailIdx: string },
    ) =>
      (await repository.find({ where: { tenantId: candidate.tenantId, ...where } })).some(
        (row) => row.id !== candidate.id,
      );
    if (
      candidate.employeeNumber !== null &&
      (await taken({ employeeNumberKey: employeeNumberKey(candidate.employeeNumber) }))
    )
      return 'employee_number';
    if (
      candidate.pii.nationalId?.index &&
      (await taken({ nationalIdIdx: candidate.pii.nationalId.index }))
    )
      return 'national_id';
    if (candidate.pii.email?.index && (await taken({ emailIdx: candidate.pii.email.index })))
      return 'email';
    return undefined;
  }

  public async insert(employee: Employee, entry: EmployeeHistoryEntry): Promise<void> {
    await this.transaction('insert', employee, async (manager) => {
      await manager.getRepository(EmployeeEntity).insert(toEmployeeRow(employee));
      await manager.getRepository(EmployeeHistoryEntity).insert(toEntryRow(entry));
    });
  }

  public async find(tenantId: string, id: string): Promise<Employee | null> {
    return this.single('find', async () => {
      const row = await this.dataSource.getRepository(EmployeeEntity).findOneBy({ tenantId, id });
      return row ? toEmployee(row) : null;
    });
  }

  public async list(
    tenantId: string,
    filter: EmployeeFilter,
    window: EmployeeWindow,
  ): Promise<EmployeeSlice> {
    return this.single('list', async () => {
      const [rows, total] = await this.dataSource.getRepository(EmployeeEntity).findAndCount({
        where: {
          tenantId,
          ...(filter.kind === undefined ? {} : { kind: filter.kind }),
          ...(filter.status === undefined ? {} : { status: filter.status }),
          ...(filter.areaId === undefined ? {} : { areaId: filter.areaId }),
          ...(filter.includeArchived ? {} : { archivedAt: IsNull() }),
        },
        order: { nameKey: 'ASC', id: 'ASC' },
        take: window.limit,
        skip: window.offset,
      });
      return { items: rows.map(toEmployee), total };
    });
  }

  public async replace(
    next: Employee,
    expectedVersion: number,
    entry?: EmployeeHistoryEntry,
  ): Promise<boolean> {
    return this.transaction('replace', next, async (manager) => {
      const result = await manager
        .getRepository(EmployeeEntity)
        .update(
          { tenantId: next.tenantId, id: next.id, version: expectedVersion },
          mutableColumns(next),
        );
      if (result.affected !== 1) return false;
      if (entry) await manager.getRepository(EmployeeHistoryEntity).insert(toEntryRow(entry));
      return true;
    });
  }

  public async countLiveInArea(tenantId: string, areaId: string): Promise<number> {
    return this.single('count', () =>
      this.dataSource.getRepository(EmployeeEntity).countBy({
        tenantId,
        areaId,
        archivedAt: IsNull(),
        status: Not('terminated'),
      }),
    );
  }

  public async history(
    tenantId: string,
    employeeId: string,
    window: EmployeeWindow,
  ): Promise<EmployeeHistorySlice> {
    return this.single('history', async () => {
      const [rows, total] = await this.dataSource
        .getRepository(EmployeeHistoryEntity)
        .findAndCount({
          where: { tenantId, employeeId },
          order: { version: 'DESC' },
          take: window.limit,
          skip: window.offset,
        });
      return { items: rows.map(toEntry), total };
    });
  }
}
