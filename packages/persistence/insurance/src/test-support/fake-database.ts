import { FindOperator, type DataSource } from 'typeorm';
import { POLICY_ENTITIES, PolicyEntity, PolicyRevisionEntity } from '../entities.js';
import { AUDIT_ENTITIES } from '../../../audit/src/index.js';

/**
 * Test double of the TypeORM surface the policy store uses (DataSource, Repository, transaction).
 * It models what the store's correctness depends on, not only return values:
 *  - primary and unique keys derived from the real EntitySchemas (NULLs never collide, as in MySQL),
 *  - the composite foreign key of a revision to its policy,
 *  - `update(criteria, values)` as one atomic conditional statement that reports `affected`,
 *  - rollback of every write of a failed transaction,
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

const clone = (row: Row): Row => {
  const copy: Row = {};
  for (const [key, value] of Object.entries(row))
    copy[key] = value instanceof Date ? new Date(value) : value;
  return copy;
};

export class FakeDatabase {
  public readonly options = {
    type: 'mysql',
    database: 'opslog_t_synthetic',
    username: 'opslog_insurance_synthetic',
    synchronize: false,
  };
  public readonly isolations: unknown[] = [];
  public readonly statements: { operation: string; table: string; where: Row | null }[] = [];
  public transactions = 0;
  /** Runs at the start of every statement; tests use it to commit a competing change in between. */
  public intercept: ((operation: string, table: string) => void) | null = null;
  private readonly tables = new Map<EntityClass, TableInfo>();
  private live = new Map<EntityClass, Map<string, Row>>();
  private readonly faults: Fault[] = [];

  public constructor() {
    for (const schema of [...POLICY_ENTITIES, ...AUDIT_ENTITIES.slice(0, 2)]) {
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
    const table = this.table(entity);
    this.live.get(entity)?.set(this.pk(table, row), clone(row));
  }

  // ---- DataSource surface -------------------------------------------------------------------

  public getRepository(entity: EntityClass): FakeRepository {
    return new FakeRepository(this, entity);
  }

  public async transaction<T>(
    isolation: unknown,
    work: (manager: { getRepository(entity: EntityClass): FakeRepository }) => Promise<T>,
  ): Promise<T> {
    this.isolations.push(isolation);
    this.transactions += 1;
    const snapshot = new Map<EntityClass, Map<string, Row>>();
    for (const [entity, rows] of this.live)
      snapshot.set(entity, new Map([...rows].map(([key, row]) => [key, clone(row)])));
    try {
      return await work({
        connection: this,
        getRepository: (entity: EntityClass) => new FakeRepository(this, entity),
      } as never);
    } catch (error) {
      this.live = snapshot;
      throw error;
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
        row?.['insurer'],
        row?.['policyNumber'],
      ]);
    }
  }

  public matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([column, expected]) =>
      this.satisfies(row[column], expected),
    );
  }

  private satisfies(actual: unknown, expected: unknown): boolean {
    if (!(expected instanceof FindOperator)) return actual === expected;
    const value = expected.value as unknown;
    const text = typeof actual === 'string' ? actual : null;
    switch (expected.type) {
      case 'and':
        return (value as readonly unknown[]).every((operator) => this.satisfies(actual, operator));
      case 'isNull':
        return actual === null || actual === undefined;
      case 'lessThan':
        return text !== null && typeof value === 'string' && text < value;
      case 'lessThanOrEqual':
        return text !== null && typeof value === 'string' && text <= value;
      case 'moreThan':
        return text !== null && typeof value === 'string' && text > value;
      case 'moreThanOrEqual':
        return text !== null && typeof value === 'string' && text >= value;
      case 'between': {
        const [from, to] = value as unknown as [string, string];
        return text !== null && text >= from && text <= to;
      }
      default:
        throw new Error(`fake database: unsupported operator ${expected.type}`);
    }
  }

  /** Unique and foreign-key checks of one row against the committed state, ignoring `except`. */
  public assertConstraints(entity: EntityClass, row: Row, except: string | null): void {
    const table = this.table(entity);
    const fail = (failure: DriverFailure) =>
      new FakeQueryFailedError(failure, `write ${table.name}`, [
        row['insurer'],
        row['policyNumber'],
      ]);
    for (const [key, other] of this.rows(entity)) {
      if (key === except) continue;
      for (const columns of [table.primary, ...table.uniques]) {
        if (columns.some((column) => row[column] === null || row[column] === undefined)) continue;
        if (columns.every((column) => row[column] === other[column])) throw fail(DUPLICATE);
      }
    }
    if (entity === PolicyRevisionEntity) {
      const parent = [...this.rows(PolicyEntity).values()].some(
        (policy) => policy['tenantId'] === row['tenantId'] && policy['id'] === row['policyId'],
      );
      if (!parent) throw fail(MISSING_PARENT);
    }
  }
}

export class FakeRepository {
  public constructor(
    private readonly db: FakeDatabase,
    private readonly entity: EntityClass,
  ) {}

  private select(where: Row): Row[] {
    return [...this.db.rows(this.entity).values()].filter((row) => this.db.matches(row, where));
  }

  public async insert(row: Row): Promise<void> {
    this.db.begin('insert', this.entity, null, row);
    this.db.assertConstraints(this.entity, row, null);
    this.db.rows(this.entity).set(this.db.pk(this.db.table(this.entity), row), clone(row));
  }

  public async findOneBy(where: Row): Promise<Row | null> {
    this.db.begin('find', this.entity, where, null);
    const found = this.select(where)[0];
    return found ? clone(found) : null;
  }

  public async countBy(where: Row): Promise<number> {
    this.db.begin('count', this.entity, where, null);
    return this.select(where).length;
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
      this.db.assertConstraints(this.entity, next, this.db.pk(this.db.table(this.entity), target));
      Object.assign(target, next);
    }
    return { affected: targets.length };
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
