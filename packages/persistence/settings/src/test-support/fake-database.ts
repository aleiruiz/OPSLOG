import type { DataSource } from 'typeorm';
import { SETTINGS_ENTITIES, SettingsEntity } from '../entities.js';

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
    username: 'opslog_settings_synthetic',
    synchronize: false,
  };
  public readonly statements: { operation: string; table: string; where: Row | null }[] = [];
  /** Runs at the start of every statement; tests use it to commit a competing change in between. */
  public intercept: ((operation: string) => void) | null = null;
  public readonly rows = new Map<string, Row>();
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

  public getRepository(entity: unknown): FakeRepository {
    if (entity !== SettingsEntity) throw new Error('fake database: unknown entity');
    return new FakeRepository(this);
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
