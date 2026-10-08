import { FindOperator, type DataSource } from 'typeorm';
import {
  AREA_ENTITIES,
  AreaEntity,
  AreaHistoryEntity,
  AreaLockEntity,
  AreaResponsibleEntity,
} from '../entities.js';
import { AUDIT_ENTITIES } from '../../../audit/src/index.js';

/**
 * Test double of the TypeORM surface the area store uses (DataSource, Repository, transaction).
 * It models what the store's correctness depends on, not only return values:
 *  - primary and unique keys derived from the real EntitySchemas (NULLs never collide, as in MySQL),
 *  - the composite foreign keys of the children and of the parent link to their area,
 *  - `update(criteria, values)` as one atomic conditional statement that reports `affected`,
 *  - rollback of every write of a failed transaction (an undo log, so concurrent transactions of
 *    other tenants are untouched),
 *  - row locks: `findOne({ lock })` blocks while another open transaction holds the same row lock,
 *    which is how the store serializes a tenant's hierarchy changes,
 *  - injected driver failures (duplicate, deadlock, ...), shaped like TypeORM's QueryFailedError.
 * Real MySQL behaviour (collation, CHECKs, true concurrency) is verified by `mysql.integration.test.ts`.
 */
export type Row = Record<string, unknown>;
type EntityClass = abstract new () => unknown;

interface TableInfo {
  readonly name: string;
  readonly primary: readonly string[];
  readonly uniques: readonly (readonly string[])[];
}

export interface DriverFailure {
  readonly errno: number;
  readonly code: string;
}

export const DUPLICATE: DriverFailure = { errno: 1062, code: 'ER_DUP_ENTRY' };
export const DEADLOCK: DriverFailure = { errno: 1213, code: 'ER_LOCK_DEADLOCK' };
export const LOCK_TIMEOUT: DriverFailure = { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' };
export const MISSING_PARENT: DriverFailure = { errno: 1452, code: 'ER_NO_REFERENCED_ROW_2' };
export const CONNECTION_LOST: DriverFailure = { errno: 2013, code: 'PROTOCOL_CONNECTION_LOST' };

/** Shaped like TypeORM's QueryFailedError: sensitive SQL parameters sit on the error itself. */
export class FakeQueryFailedError extends Error {
  public readonly driverError: DriverFailure;
  public constructor(
    failure: DriverFailure,
    public readonly query: string,
    public readonly parameters: readonly unknown[],
  ) {
    super(`${failure.code}: ${query} -- ${JSON.stringify(parameters)}`);
    this.name = 'QueryFailedError';
    this.driverError = failure;
  }
}

interface Fault {
  readonly entity: EntityClass | null;
  readonly operation: string;
  remaining: number;
  readonly failure: DriverFailure;
  readonly leak: string;
}

interface Undo {
  readonly entity: EntityClass;
  readonly key: string;
  readonly before: Row | undefined;
}

interface Transaction {
  readonly undo: Undo[];
  readonly held: Set<string>;
}

const clone = (row: Row): Row => {
  const copy: Row = {};
  for (const [key, value] of Object.entries(row))
    copy[key] = value instanceof Date ? new Date(value) : value;
  return copy;
};

/** Foreign keys: child columns -> parent entity columns (a NULL child column skips the check). */
const FOREIGN_KEYS: readonly {
  readonly child: EntityClass;
  readonly columns: readonly [string, string];
  readonly parent: EntityClass;
}[] = [
  { child: AreaEntity, columns: ['tenantId', 'parentId'], parent: AreaEntity },
  { child: AreaResponsibleEntity, columns: ['tenantId', 'areaId'], parent: AreaEntity },
  { child: AreaHistoryEntity, columns: ['tenantId', 'areaId'], parent: AreaEntity },
];

export class FakeDatabase {
  public readonly options = {
    type: 'mysql',
    database: 'opslog_t_synthetic',
    username: 'opslog_areas_synthetic',
    synchronize: false,
  };
  public readonly isolations: unknown[] = [];
  public readonly statements: { operation: string; table: string; where: Row | null }[] = [];
  public transactions = 0;
  /** Runs at the start of every statement; tests use it to commit a competing change in between. */
  public intercept: ((operation: string, table: string) => void) | null = null;
  private readonly tables = new Map<EntityClass, TableInfo>();
  private readonly live = new Map<EntityClass, Map<string, Row>>();
  private readonly faults: Fault[] = [];
  private readonly lockOwners = new Map<string, Transaction>();
  private readonly lockWaiters = new Map<string, (() => void)[]>();

  public constructor() {
    for (const schema of [...AREA_ENTITIES, ...AUDIT_ENTITIES.slice(0, 2)]) {
      const options = schema.options;
      const target = options.target as EntityClass;
      const columns = Object.entries(options.columns as Record<string, { primary?: boolean }>);
      this.tables.set(target, {
        name: options.tableName ?? options.name,
        primary: columns.filter(([, c]) => c.primary).map(([name]) => name),
        uniques: (options.uniques ?? []).map((u) => [...(u.columns as string[])]),
      });
      this.live.set(target, new Map());
    }
  }

  // ---- test controls ------------------------------------------------------------------------

  public failNext(
    operation: string,
    failure: DriverFailure,
    options: { entity?: EntityClass; times?: number; leak?: string } = {},
  ): void {
    this.faults.push({
      entity: options.entity ?? null,
      operation,
      remaining: options.times ?? 1,
      failure,
      leak: options.leak ?? '<redacted-by-test>',
    });
  }

  public committed(entity: EntityClass): Row[] {
    return [...(this.live.get(entity)?.values() ?? [])].map(clone);
  }

  /** Writes a row directly, bypassing every constraint (simulates an out-of-band change). */
  public seed(entity: EntityClass, row: Row): void {
    this.rows(entity).set(this.pk(this.table(entity), row), clone(row));
  }

  // ---- DataSource surface -------------------------------------------------------------------

  public getRepository(entity: EntityClass): FakeRepository {
    return new FakeRepository(this, entity, null);
  }

  public async transaction<T>(
    isolation: unknown,
    work: (manager: { getRepository(entity: EntityClass): FakeRepository }) => Promise<T>,
  ): Promise<T> {
    this.isolations.push(isolation);
    this.transactions += 1;
    const tx: Transaction = { undo: [], held: new Set() };
    try {
      return await work({
        connection: this,
        getRepository: (entity: EntityClass) => new FakeRepository(this, entity, tx),
      } as never);
    } catch (error) {
      for (const step of tx.undo.reverse()) {
        const rows = this.rows(step.entity);
        if (step.before) rows.set(step.key, step.before);
        else rows.delete(step.key);
      }
      throw error;
    } finally {
      for (const key of tx.held) {
        this.lockOwners.delete(key);
        for (const wake of this.lockWaiters.get(key)?.splice(0) ?? []) wake();
      }
    }
  }

  // ---- engine -------------------------------------------------------------------------------

  public table(entity: EntityClass): TableInfo {
    const table = this.tables.get(entity);
    if (!table) throw new Error('fake database: unknown entity');
    return table;
  }

  public rows(entity: EntityClass): Map<string, Row> {
    return this.live.get(entity) as Map<string, Row>;
  }

  public pk(table: TableInfo, row: Row): string {
    return table.primary.map((column) => String(row[column])).join('\u0000');
  }

  public async acquire(entity: EntityClass, where: Row, tx: Transaction): Promise<void> {
    const key = `${String(this.table(entity).name)}\u0000${JSON.stringify(where)}`;
    while (this.lockOwners.has(key) && this.lockOwners.get(key) !== tx)
      await new Promise<void>((resolve) => {
        const waiting = this.lockWaiters.get(key) ?? [];
        waiting.push(resolve);
        this.lockWaiters.set(key, waiting);
      });
    this.lockOwners.set(key, tx);
    tx.held.add(key);
  }

  public begin(operation: string, entity: EntityClass, where: Row | null, row: Row | null): void {
    const table = this.table(entity);
    this.statements.push({ operation, table: table.name, where });
    this.intercept?.(operation, table.name);
    const fault = this.faults.find(
      (candidate) =>
        candidate.remaining > 0 &&
        candidate.operation === operation &&
        (candidate.entity === null || candidate.entity === entity),
    );
    if (fault) {
      fault.remaining -= 1;
      throw new FakeQueryFailedError(fault.failure, `${operation} ${table.name}`, [
        fault.leak,
        row?.['name'],
        row?.['code'],
      ]);
    }
  }

  public matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([column, expected]) => {
      const actual = row[column];
      if (expected instanceof FindOperator) {
        const value = expected.value as unknown;
        switch (expected.type) {
          case 'isNull':
            return actual === null || actual === undefined;
          case 'in':
            return (value as unknown[]).includes(actual);
          default:
            throw new Error(`fake database: unsupported operator ${expected.type}`);
        }
      }
      return actual === expected;
    });
  }

  /** Unique and foreign-key checks of one row against the committed state, ignoring `except`. */
  public assertConstraints(entity: EntityClass, row: Row, except: string | null): void {
    const table = this.table(entity);
    const fail = (failure: DriverFailure) =>
      new FakeQueryFailedError(failure, `write ${table.name}`, [row['name'], row['code']]);
    for (const [key, other] of this.rows(entity)) {
      if (key === except) continue;
      for (const columns of [table.primary, ...table.uniques]) {
        if (columns.some((column) => row[column] === null || row[column] === undefined)) continue;
        if (columns.every((column) => row[column] === other[column])) throw fail(DUPLICATE);
      }
    }
    for (const key of FOREIGN_KEYS.filter((candidate) => candidate.child === entity)) {
      const [tenantColumn, referenceColumn] = key.columns;
      if (row[referenceColumn] === null || row[referenceColumn] === undefined) continue;
      const found = [...this.rows(key.parent).values()].some(
        (parent) =>
          parent['tenantId'] === row[tenantColumn] && parent['id'] === row[referenceColumn],
      );
      if (!found) throw fail(MISSING_PARENT);
    }
  }
}

export class FakeRepository {
  public constructor(
    private readonly db: FakeDatabase,
    private readonly entity: EntityClass,
    private readonly tx: Transaction | null,
  ) {}

  private select(where: Row): Row[] {
    return [...this.db.rows(this.entity).values()].filter((row) => this.db.matches(row, where));
  }

  private write(key: string, row: Row | undefined): void {
    const rows = this.db.rows(this.entity);
    this.tx?.undo.push({ entity: this.entity, key, before: rows.get(key) });
    if (row) rows.set(key, row);
    else rows.delete(key);
  }

  public async insert(row: Row): Promise<void> {
    this.db.begin('insert', this.entity, null, row);
    this.db.assertConstraints(this.entity, row, null);
    this.write(this.db.pk(this.db.table(this.entity), row), clone(row));
  }

  public async findOneBy(where: Row): Promise<Row | null> {
    this.db.begin('find', this.entity, where, null);
    const found = this.select(where)[0];
    return found ? clone(found) : null;
  }

  /** Only the locking form is used: `SELECT ... FOR UPDATE` of one row. */
  public async findOne(options: { where: Row; lock: { mode: string } }): Promise<Row | null> {
    this.db.begin('lock', this.entity, options.where, null);
    if (!this.tx) throw new Error('fake database: a row lock needs a transaction');
    await this.db.acquire(this.entity, options.where, this.tx);
    const found = this.select(options.where)[0];
    return found ? clone(found) : null;
  }

  public async find(options: {
    where: Row;
    order?: Record<string, 'ASC' | 'DESC'>;
  }): Promise<Row[]> {
    this.db.begin('find', this.entity, options.where, null);
    return this.sorted(this.select(options.where), options.order).map(clone);
  }

  public async findAndCount(options: {
    where: Row;
    order?: Record<string, 'ASC' | 'DESC'>;
    take?: number;
    skip?: number;
  }): Promise<[Row[], number]> {
    this.db.begin('list', this.entity, options.where, null);
    const all = this.sorted(this.select(options.where), options.order);
    const skip = options.skip ?? 0;
    return [all.slice(skip, skip + (options.take ?? all.length)).map(clone), all.length];
  }

  /** One atomic conditional UPDATE: matches by `where`, checks constraints, reports `affected`. */
  public async update(where: Row, values: Row): Promise<{ affected: number }> {
    this.db.begin('update', this.entity, where, values);
    const targets = this.select(where);
    for (const target of targets) {
      const next = { ...target, ...clone(values) };
      const key = this.db.pk(this.db.table(this.entity), target);
      this.db.assertConstraints(this.entity, next, key);
      this.write(key, next);
    }
    return { affected: targets.length };
  }

  public async delete(where: Row): Promise<void> {
    this.db.begin('delete', this.entity, where, null);
    for (const target of this.select(where))
      this.write(this.db.pk(this.db.table(this.entity), target), undefined);
  }

  private sorted(rows: Row[], order: Record<string, 'ASC' | 'DESC'> | undefined): Row[] {
    const keys = Object.entries(order ?? {});
    return [...rows].sort((a, b) => {
      for (const [column, direction] of keys) {
        const left = a[column] as number | string;
        const right = b[column] as number | string;
        if (left === right) continue;
        return (left < right ? -1 : 1) * (direction === 'ASC' ? 1 : -1);
      }
      return 0;
    });
  }
}

/** The fake is not a full DataSource; the store only uses the surface above. */
export const asDataSource = (db: FakeDatabase): DataSource => db as unknown as DataSource;
export { AreaEntity, AreaHistoryEntity, AreaLockEntity, AreaResponsibleEntity };
