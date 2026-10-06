import { FindOperator, type DataSource } from 'typeorm';
import {
  ExternalIdentityEntity,
  IDENTITY_ENTITIES,
  IdentityEntity,
  InvitationEntity,
  MembershipEntity,
  RecoveryEntity,
  SessionEntity,
} from '../entities.js';

/**
 * Test double of the TypeORM surface the identity store uses (DataSource, Repository, transaction).
 * It models what the store's correctness depends on, not just return values:
 *  - primary/unique keys and composite foreign keys derived from the real EntitySchemas,
 *  - exclusive row locks held until commit/rollback (`lock: pessimistic_write`, UPDATE, INSERT),
 *  - READ COMMITTED reads (other transactions' uncommitted writes are invisible, locking reads see the latest row),
 *  - rollback of every write of a failed transaction and deadlock detection (errno 1213).
 * Real MySQL behaviour is verified separately by `mysql.integration.test.ts`.
 */
export type Row = Record<string, unknown>;
type EntityClass = abstract new () => unknown;

interface TableInfo {
  readonly entity: EntityClass;
  readonly name: string;
  readonly primary: readonly string[];
  readonly uniques: readonly (readonly string[])[];
  readonly nullable: ReadonlySet<string>;
  readonly columns: ReadonlySet<string>;
}

interface ForeignKey {
  readonly child: EntityClass;
  readonly columns: readonly string[];
  readonly parent: EntityClass;
  readonly parentColumns: readonly string[];
}

const FOREIGN_KEYS: readonly ForeignKey[] = [
  {
    child: ExternalIdentityEntity,
    columns: ['identityId'],
    parent: IdentityEntity,
    parentColumns: ['id'],
  },
  {
    child: MembershipEntity,
    columns: ['identityId'],
    parent: IdentityEntity,
    parentColumns: ['id'],
  },
  {
    child: InvitationEntity,
    columns: ['tenantId', 'identityId'],
    parent: MembershipEntity,
    parentColumns: ['tenantId', 'identityId'],
  },
  {
    child: RecoveryEntity,
    columns: ['identityId'],
    parent: IdentityEntity,
    parentColumns: ['id'],
  },
  {
    child: SessionEntity,
    columns: ['tenantId', 'identityId'],
    parent: MembershipEntity,
    parentColumns: ['tenantId', 'identityId'],
  },
];

export interface DriverFailure {
  readonly errno: number;
  readonly code: string;
}

export const DEADLOCK: DriverFailure = { errno: 1213, code: 'ER_LOCK_DEADLOCK' };
export const LOCK_TIMEOUT: DriverFailure = { errno: 1205, code: 'ER_LOCK_WAIT_TIMEOUT' };

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

export class Tx {
  public readonly locks = new Set<string>();
  public readonly undo: { key: string; entity: EntityClass; pk: string }[] = [];
  public waitingFor: Tx | null = null;
  public constructor(public readonly id: number) {}
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

const tick = (): Promise<void> => Promise.resolve();

export class FakeDatabase {
  public readonly options = {
    type: 'mysql',
    username: 'opslog_identity_synthetic',
    synchronize: false,
  };
  public readonly statements: string[] = [];
  public readonly isolations: unknown[] = [];
  /** Runs at the start of every statement (tests use it to inject a concurrent committed change). */
  public intercept: ((operation: string, table: string) => void) | null = null;
  public deadlocks = 0;
  public transactions = 0;
  public maxConcurrentTransactions = 0;
  private active = 0;
  private txSeq = 0;
  private readonly tables = new Map<EntityClass, TableInfo>();
  private readonly live = new Map<EntityClass, Map<string, Row>>();
  /** Before-images of rows written by a still-open transaction. */
  private readonly dirty = new Map<string, { owner: Tx; before: Row | null }>();
  private readonly owners = new Map<string, { owner: Tx; waiters: (() => void)[] }>();
  private readonly faults: Fault[] = [];

  public constructor() {
    for (const schema of IDENTITY_ENTITIES) {
      const options = schema.options;
      const target = options.target as EntityClass;
      const columns = Object.entries(
        options.columns as Record<string, { primary?: boolean; nullable?: boolean }>,
      );
      this.tables.set(target, {
        entity: target,
        name: options.tableName ?? options.name,
        primary: columns.filter(([, c]) => c.primary).map(([name]) => name),
        uniques: (options.uniques ?? []).map((u) => [...(u.columns as string[])]),
        nullable: new Set(columns.filter(([, c]) => c.nullable).map(([name]) => name)),
        columns: new Set(columns.map(([name]) => name)),
      });
      this.live.set(target, new Map());
    }
  }

  // ---- test controls ------------------------------------------------------------------------

  /** Makes the next `times` statements of `operation` (on `entity`, or any) fail with a driver error. */
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

  /** Committed rows of a table (what another connection would read). */
  public committed(entity: EntityClass): Row[] {
    return this.visible(entity, null).map(clone);
  }

  /** Removes every committed row of a table (simulates an out-of-band change). */
  public clear(entity: EntityClass): void {
    this.live.get(entity)?.clear();
  }

  public seed(entity: EntityClass, row: Row): void {
    const table = this.table(entity);
    this.live.get(entity)?.set(this.pk(table, row), clone(row));
  }

  // ---- DataSource surface -------------------------------------------------------------------

  public getRepository(entity: EntityClass): FakeRepository {
    return new FakeRepository(this, entity, null);
  }

  public async transaction<T>(
    isolationOrWork: unknown,
    maybeWork?: (manager: { getRepository(entity: EntityClass): FakeRepository }) => Promise<T>,
  ): Promise<T> {
    const work = (maybeWork ?? isolationOrWork) as NonNullable<typeof maybeWork>;
    this.isolations.push(maybeWork ? isolationOrWork : undefined);
    this.transactions += 1;
    this.active += 1;
    this.maxConcurrentTransactions = Math.max(this.maxConcurrentTransactions, this.active);
    const tx = new Tx(++this.txSeq);
    try {
      const result = await work({
        getRepository: (entity) => new FakeRepository(this, entity, tx),
      });
      this.finish(tx, false);
      return result;
    } catch (error) {
      this.finish(tx, true);
      throw error;
    } finally {
      this.active -= 1;
    }
  }

  // ---- engine -------------------------------------------------------------------------------

  private table(entity: EntityClass): TableInfo {
    const table = this.tables.get(entity);
    if (!table) throw new Error('fake database: unknown entity');
    return table;
  }

  private pk(table: TableInfo, row: Row): string {
    return table.primary.map((column) => String(row[column])).join('\u0000');
  }

  private key(table: TableInfo, pk: string): string {
    return `${table.name}|${pk}`;
  }

  private finish(tx: Tx, rollback: boolean): void {
    if (rollback)
      for (const entry of [...tx.undo].reverse()) {
        const dirty = this.dirty.get(entry.key);
        if (dirty?.owner !== tx) continue;
        const rows = this.live.get(entry.entity);
        if (dirty.before) rows?.set(entry.pk, dirty.before);
        else rows?.delete(entry.pk);
      }
    for (const entry of tx.undo)
      if (this.dirty.get(entry.key)?.owner === tx) this.dirty.delete(entry.key);
    for (const key of tx.locks) {
      const held = this.owners.get(key);
      if (held?.owner !== tx) continue;
      this.owners.delete(key);
      for (const wake of held.waiters) wake();
    }
    tx.locks.clear();
  }

  /** Rows visible to `tx` under READ COMMITTED: own writes plus committed data. */
  private visible(entity: EntityClass, tx: Tx | null): Row[] {
    const table = this.table(entity);
    const rows = this.live.get(entity) ?? new Map<string, Row>();
    const out: Row[] = [];
    for (const [pk, row] of rows) {
      const dirty = this.dirty.get(this.key(table, pk));
      if (dirty && dirty.owner !== tx) {
        if (dirty.before) out.push(dirty.before);
      } else out.push(row);
    }
    for (const [key, dirty] of this.dirty) {
      if (!key.startsWith(`${table.name}|`) || dirty.owner === tx || !dirty.before) continue;
      const pk = key.slice(table.name.length + 1);
      if (!rows.has(pk)) out.push(dirty.before);
    }
    return out;
  }

  private matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([column, expected]) => {
      const actual = row[column];
      if (expected instanceof FindOperator) {
        const value = expected.value as unknown;
        switch (expected.type) {
          case 'isNull':
            return actual === null || actual === undefined;
          case 'moreThan':
            return actual instanceof Date && value instanceof Date && actual > value;
          case 'lessThan':
            return actual instanceof Date && value instanceof Date && actual < value;
          default:
            throw new Error(`fake database: unsupported operator ${expected.type}`);
        }
      }
      if (expected instanceof Date)
        return actual instanceof Date && actual.getTime() === expected.getTime();
      return actual === expected;
    });
  }

  private async acquire(tx: Tx, key: string): Promise<void> {
    for (;;) {
      const held = this.owners.get(key);
      if (!held) {
        this.owners.set(key, { owner: tx, waiters: [] });
        tx.locks.add(key);
        return;
      }
      if (held.owner === tx) return;
      this.assertNoCycle(tx, held.owner);
      tx.waitingFor = held.owner;
      await new Promise<void>((resolve) => held.waiters.push(resolve));
      tx.waitingFor = null;
    }
  }

  private assertNoCycle(requester: Tx, owner: Tx): void {
    for (let next: Tx | null = owner; next; next = next.waitingFor)
      if (next === requester) {
        this.deadlocks += 1;
        throw new FakeQueryFailedError(DEADLOCK, 'deadlock', []);
      }
  }

  /** Waits (without taking a lock) until no other transaction holds the row, like an FK check on a locked parent. */
  private async waitUnlocked(tx: Tx, key: string): Promise<void> {
    for (;;) {
      const held = this.owners.get(key);
      if (!held || held.owner === tx) return;
      this.assertNoCycle(tx, held.owner);
      tx.waitingFor = held.owner;
      await new Promise<void>((resolve) => held.waiters.push(resolve));
      tx.waitingFor = null;
    }
  }

  private fault(operation: string, entity: EntityClass): void {
    this.intercept?.(operation, this.table(entity).name);
    const fault = this.faults.find(
      (f) =>
        f.remaining > 0 && f.operation === operation && (f.entity === null || f.entity === entity),
    );
    if (!fault) return;
    fault.remaining -= 1;
    throw new FakeQueryFailedError(fault.failure, operation, [fault.leak]);
  }

  private async withTx<T>(tx: Tx | null, work: (tx: Tx) => Promise<T>): Promise<T> {
    if (tx) return work(tx);
    const implicit = new Tx(++this.txSeq);
    try {
      const result = await work(implicit);
      this.finish(implicit, false);
      return result;
    } catch (error) {
      this.finish(implicit, true);
      throw error;
    }
  }

  /**
   * Rows matching `where`, all exclusively locked. Rows that another open transaction is rewriting
   * are candidates too: the caller waits for that transaction, then re-evaluates the latest row.
   */
  private async lockedMatches(tx: Tx, entity: EntityClass, where: Row): Promise<Row[]> {
    const table = this.table(entity);
    const candidates = (): Map<string, Row | null> => {
      const found = new Map<string, Row | null>();
      for (const [pk, row] of this.live.get(entity) ?? [])
        if (this.matches(row, where)) found.set(pk, row);
      for (const [key, dirty] of this.dirty) {
        if (!key.startsWith(`${table.name}|`) || dirty.owner === tx) continue;
        const pk = key.slice(table.name.length + 1);
        if (dirty.before && this.matches(dirty.before, where) && !found.has(pk))
          found.set(pk, null);
      }
      return found;
    };
    for (let round = 0; round < 50; round += 1) {
      const first = candidates();
      for (const pk of first.keys()) await this.acquire(tx, this.key(table, pk));
      const second = candidates();
      const stable =
        second.size === first.size &&
        [...second].every(([pk, row]) => first.has(pk) && first.get(pk) === row);
      if (stable) return [...second.values()].filter((row): row is Row => row !== null);
    }
    throw new Error('fake database: lock acquisition did not converge');
  }

  private touch(tx: Tx, entity: EntityClass, pk: string, before: Row | null): void {
    const table = this.table(entity);
    const key = this.key(table, pk);
    if (this.dirty.has(key)) return;
    this.dirty.set(key, { owner: tx, before: before ? clone(before) : null });
    tx.undo.push({ key, entity, pk });
  }

  public async select(
    tx: Tx | null,
    entity: EntityClass,
    operation: string,
    options: { where: Row; lock?: boolean },
  ): Promise<Row[]> {
    this.statements.push(
      `${operation} ${this.table(entity).name}${options.lock ? ' FOR UPDATE' : ''}`,
    );
    await tick();
    this.fault(operation, entity);
    return this.withTx(tx, async (t) => {
      const rows = options.lock
        ? await this.lockedMatches(t, entity, options.where)
        : this.visible(entity, t).filter((row) => this.matches(row, options.where));
      return rows.map(clone);
    });
  }

  public async insert(tx: Tx | null, entity: EntityClass, row: Row): Promise<void> {
    const table = this.table(entity);
    this.statements.push(`insert ${table.name}`);
    await tick();
    this.fault('insert', entity);
    await this.withTx(tx, async (t) => {
      for (const column of Object.keys(row))
        if (!table.columns.has(column)) throw new Error(`fake database: unknown column ${column}`);
      for (const column of table.columns)
        if (row[column] === undefined && !table.nullable.has(column))
          throw new Error(`fake database: column ${column} cannot be null`);
      for (const fk of FOREIGN_KEYS.filter((candidate) => candidate.child === entity)) {
        const parentTable = this.table(fk.parent);
        const where: Row = {};
        fk.columns.forEach((column, i) => (where[fk.parentColumns[i] as string] = row[column]));
        for (;;) {
          const parent = [...(this.live.get(fk.parent)?.values() ?? [])].find((candidate) =>
            this.matches(candidate, where),
          );
          if (!parent)
            throw new FakeQueryFailedError(
              { errno: 1452, code: 'ER_NO_REFERENCED_ROW_2' },
              'insert',
              ['<redacted-by-test>'],
            );
          const parentKey = this.key(parentTable, this.pk(parentTable, parent));
          const holder = this.owners.get(parentKey);
          if (!holder || holder.owner === t) break;
          await this.waitUnlocked(t, parentKey);
        }
      }
      const pk = this.pk(table, row);
      const newKey = this.key(table, pk);
      // Uniqueness check and the write below form one synchronous step (no await in between), like
      // the engine's atomic insert; contention with an uncommitted row of another transaction waits first.
      for (;;) {
        let blocking: string | null = null;
        for (const unique of [table.primary, ...table.uniques]) {
          const where: Row = {};
          for (const column of unique) where[column] = row[column];
          const conflict = [...(this.live.get(entity)?.values() ?? [])].find((candidate) =>
            this.matches(candidate, where),
          );
          if (!conflict) continue;
          const conflictKey = this.key(table, this.pk(table, conflict));
          const holder = this.owners.get(conflictKey);
          if (holder && holder.owner !== t) {
            blocking = conflictKey;
            break;
          }
          throw new FakeQueryFailedError({ errno: 1062, code: 'ER_DUP_ENTRY' }, 'insert', [
            '<redacted-by-test>',
          ]);
        }
        const holder = this.owners.get(newKey);
        if (!blocking && holder && holder.owner !== t) blocking = newKey;
        if (!blocking) break;
        await this.waitUnlocked(t, blocking);
      }
      this.owners.set(newKey, { owner: t, waiters: [] });
      t.locks.add(newKey);
      this.touch(t, entity, pk, null);
      this.live.get(entity)?.set(pk, clone(row));
    });
  }

  public async update(
    tx: Tx | null,
    entity: EntityClass,
    where: Row,
    patch: (row: Row) => Row,
    operation = 'update',
  ): Promise<number> {
    const table = this.table(entity);
    this.statements.push(`${operation} ${table.name}`);
    await tick();
    this.fault(operation, entity);
    return this.withTx(tx, async (t) => {
      const rows = await this.lockedMatches(t, entity, where);
      for (const row of rows) {
        const pk = this.pk(table, row);
        const next = patch(clone(row));
        for (const unique of table.uniques) {
          const clash = [...(this.live.get(entity)?.values() ?? [])].find(
            (other) => other !== row && unique.every((column) => other[column] === next[column]),
          );
          if (clash)
            throw new FakeQueryFailedError({ errno: 1062, code: 'ER_DUP_ENTRY' }, operation, []);
        }
        this.touch(t, entity, pk, row);
        this.live.get(entity)?.set(pk, next);
      }
      return rows.length;
    });
  }

  public async delete(tx: Tx | null, entity: EntityClass, where: Row): Promise<number> {
    const table = this.table(entity);
    this.statements.push(`delete ${table.name}`);
    await tick();
    this.fault('delete', entity);
    return this.withTx(tx, async (t) => {
      const rows = await this.lockedMatches(t, entity, where);
      for (const row of rows) {
        const pk = this.pk(table, row);
        this.touch(t, entity, pk, row);
        this.live.get(entity)?.delete(pk);
      }
      return rows.length;
    });
  }
}

export class FakeRepository {
  public constructor(
    private readonly db: FakeDatabase,
    private readonly entity: EntityClass,
    private readonly tx: Tx | null,
  ) {}

  public async findOneBy(where: Row): Promise<Row | null> {
    const rows = await this.db.select(this.tx, this.entity, 'findOneBy', { where });
    return rows[0] ?? null;
  }

  public async findOne(options: { where: Row; lock?: { mode: string } }): Promise<Row | null> {
    if (options.lock && !this.tx) throw new Error('fake database: lock outside a transaction');
    const rows = await this.db.select(this.tx, this.entity, 'findOne', {
      where: options.where,
      lock: options.lock?.mode === 'pessimistic_write',
    });
    return rows[0] ?? null;
  }

  public async find(options: { where: Row; lock?: { mode: string } }): Promise<Row[]> {
    if (options.lock && !this.tx) throw new Error('fake database: lock outside a transaction');
    return this.db.select(this.tx, this.entity, 'find', {
      where: options.where,
      lock: options.lock?.mode === 'pessimistic_write',
    });
  }

  public async count(options: { where: Row }): Promise<number> {
    return (await this.db.select(this.tx, this.entity, 'count', { where: options.where })).length;
  }

  public async insert(row: Row): Promise<void> {
    await this.db.insert(this.tx, this.entity, row);
  }

  public async update(where: Row, patch: Row): Promise<{ affected: number }> {
    const affected = await this.db.update(this.tx, this.entity, where, (row) => ({
      ...row,
      ...patch,
    }));
    return { affected };
  }

  public async increment(where: Row, column: string, by: number): Promise<{ affected: number }> {
    const affected = await this.db.update(
      this.tx,
      this.entity,
      where,
      (row) => ({ ...row, [column]: (row[column] as number) + by }),
      'increment',
    );
    return { affected };
  }

  public async delete(where: Row): Promise<{ affected: number }> {
    return { affected: await this.db.delete(this.tx, this.entity, where) };
  }
}

export const asDataSource = (db: FakeDatabase): DataSource => db as unknown as DataSource;
