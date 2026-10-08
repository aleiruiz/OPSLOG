import type { DataSource } from 'typeorm';
import { SETTINGS_ENTITIES, SettingsEntity } from '../entities.js';
import { AuditDeliveryEntity, AuditLocalEventEntity } from '../../../audit/src/entities.js';

/**
 * Test double of the TypeORM surface the settings store uses (DataSource and Repository). It models
 * what the store's correctness depends on, not only return values:
 *  - the primary key derived from the real EntitySchema (a second insert of a company collides),
 *  - `update(criteria, values)` as one atomic conditional statement that reports `affected`,
 *  - injected driver failures (duplicate, deadlock, ...), shaped like TypeORM's QueryFailedError.
 * Real MySQL behaviour (collation, CHECKs, true concurrency) is verified by `mysql.integration.test.ts`.
 */
export type Row = Record<string, unknown>;

export interface DriverFailure {
  readonly errno: number;
  readonly code: string;
}

export const DUPLICATE: DriverFailure = { errno: 1062, code: 'ER_DUP_ENTRY' };
export const DEADLOCK: DriverFailure = { errno: 1213, code: 'ER_LOCK_DEADLOCK' };
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

const TABLE = SETTINGS_ENTITIES[0].options.tableName as string;

export class FakeDatabase {
  public readonly options = {
    type: 'mysql',
    database: 'opslog_t_synthetic',
    username: 'opslog_settings_synthetic',
    synchronize: false,
  };
  public readonly statements: { operation: string; table: string; where: Row | null }[] = [];
  /** Runs at the start of every statement; tests use it to commit a competing change in between. */
  public intercept: ((operation: string) => void) | null = null;
  public readonly rows = new Map<string, Row>();
  public readonly auditRows = new Map<unknown, Map<string, Row>>([
    [AuditLocalEventEntity, new Map()],
    [AuditDeliveryEntity, new Map()],
  ]);
  private readonly faults: Fault[] = [];

  public failNext(
    operation: string,
    failure: DriverFailure,
    options: { times?: number; leak?: string } = {},
  ): void {
    this.faults.push({
      operation,
      remaining: options.times ?? 1,
      failure,
      leak: options.leak ?? '<redacted-by-test>',
    });
  }

  public committed(): Row[] {
    return [...this.rows.values()].map(clone);
  }

  /** Writes a row directly, bypassing every constraint (simulates an out-of-band change). */
  public seed(row: Row): void {
    this.rows.set(String(row['tenantId']), clone(row));
  }

  public getRepository(entity: unknown): FakeRepository | FakeAuditRepository {
    if (entity === SettingsEntity) return new FakeRepository(this);
    if (this.auditRows.has(entity)) return new FakeAuditRepository(this, entity);
    throw new Error('fake database: unknown entity');
  }

  public async transaction<T>(work: (manager: never) => Promise<T>): Promise<T> {
    const rowsBefore = new Map([...this.rows].map(([key, row]) => [key, clone(row)]));
    const auditBefore = new Map(
      [...this.auditRows].map(([entity, rows]) => [
        entity,
        new Map([...rows].map(([key, row]) => [key, clone(row)])),
      ]),
    );
    try {
      return await work({
        connection: this,
        getRepository: (entity: unknown) => this.getRepository(entity),
      } as never);
    } catch (error) {
      this.rows.clear();
      for (const [key, row] of rowsBefore) this.rows.set(key, row);
      for (const [entity, rows] of auditBefore) this.auditRows.set(entity, rows);
      throw error;
    }
  }

  public begin(operation: string, where: Row | null, row: Row | null): void {
    this.statements.push({ operation, table: TABLE, where });
    this.intercept?.(operation);
    const fault = this.faults.find(
      (candidate) => candidate.remaining > 0 && candidate.operation === operation,
    );
    if (fault) {
      fault.remaining -= 1;
      throw new FakeQueryFailedError(fault.failure, `${operation} ${TABLE}`, [
        fault.leak,
        row?.['updatedBy'],
      ]);
    }
  }
}

export class FakeAuditRepository {
  public constructor(
    private readonly db: FakeDatabase,
    private readonly entity: unknown,
  ) {}
  public async findOneBy(where: Row): Promise<Row | null> {
    this.db.begin('find', where, null);
    const rows = this.db.auditRows.get(this.entity);
    const found = [...(rows?.values() ?? [])].find((row) =>
      Object.entries(where).every(([column, expected]) => row[column] === expected),
    );
    return found ? clone(found) : null;
  }
  public async insert(row: Row): Promise<void> {
    this.db.begin('insert', null, row);
    this.db.auditRows.get(this.entity)?.set(String(row['eventId']), clone(row));
  }
}

export class FakeRepository {
  public constructor(private readonly db: FakeDatabase) {}

  private select(where: Row): Row[] {
    return [...this.db.rows.values()].filter((row) =>
      Object.entries(where).every(([column, expected]) => row[column] === expected),
    );
  }

  public async insert(row: Row): Promise<void> {
    this.db.begin('insert', null, row);
    if (this.db.rows.has(String(row['tenantId'])))
      throw new FakeQueryFailedError(DUPLICATE, `write ${TABLE}`, [row['updatedBy']]);
    this.db.rows.set(String(row['tenantId']), clone(row));
  }

  public async findOneBy(where: Row): Promise<Row | null> {
    this.db.begin('find', where, null);
    const found = this.select(where)[0];
    return found ? clone(found) : null;
  }

  /** One atomic conditional UPDATE: matches by `where`, reports `affected`. */
  public async update(where: Row, values: Row): Promise<{ affected: number }> {
    this.db.begin('update', where, values);
    const targets = this.select(where);
    for (const target of targets) Object.assign(target, clone(values));
    return { affected: targets.length };
  }
}

/** The fake is not a full DataSource; the store only uses the surface above. */
export const asDataSource = (db: FakeDatabase): DataSource => db as unknown as DataSource;
