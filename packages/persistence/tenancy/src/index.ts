import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';

export type TenantStatus = 'provisioning' | 'active' | 'failed' | 'suspended';

export interface TenantDirectoryEntry {
  readonly tenantId: string;
  readonly databaseName: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly secretVersion: string;
  readonly status: TenantStatus;
  readonly authorizationVersion: number;
}

export interface TenantDirectory {
  find(tenantId: string): Promise<TenantDirectoryEntry | undefined>;
  save(entry: TenantDirectoryEntry): Promise<void>;
}

export interface PoolLimits {
  readonly perTenant: number;
  readonly total: number;
  readonly idleTimeoutMs?: number;
}

export interface TenantConnection {
  readonly tenantId: string;
  readonly databaseName: string;
  readonly secretVersion: string;
  readonly pool: Pool;
  close(): Promise<void>;
}

export class TenantAccessError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TenantAccessError';
  }
}

export function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new TenantAccessError('unsafe database identifier');
  return `\`${value}\``;
}

export function assertTenantId(tenantId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(tenantId)) throw new TenantAccessError('invalid tenant id');
}

export function createTenantContextFactory(directory: TenantDirectory) {
  return async function createContext(tenantId: string, expectedAuthorizationVersion: number): Promise<TenantDirectoryEntry> {
    assertTenantId(tenantId);
    const entry = await directory.find(tenantId);
    if (!entry || entry.status !== 'active' || entry.authorizationVersion !== expectedAuthorizationVersion) {
      throw new TenantAccessError('tenant context is unavailable');
    }
    return Object.freeze({ ...entry });
  };
}

export class TenantPoolRegistry {
  private readonly pools = new Map<string, Promise<TenantConnection>>();
  private readonly opened = new Set<TenantConnection>();

  public constructor(private readonly limits: PoolLimits) {
    if (!Number.isInteger(limits.perTenant) || limits.perTenant < 1) throw new Error('perTenant pool limit must be positive');
    if (!Number.isInteger(limits.total) || limits.total < 1) throw new Error('total pool limit must be positive');
  }

  public get size(): number { return this.opened.size; }

  public async get(entry: TenantDirectoryEntry): Promise<TenantConnection> {
    if (entry.status !== 'active') throw new TenantAccessError('cannot open a pool for an inactive tenant');
    const key = `${entry.tenantId}:${entry.secretVersion}`;
    const existing = this.pools.get(key);
    if (existing) return existing;
    if (this.opened.size >= this.limits.total) throw new TenantAccessError('tenant pool capacity exhausted');
    const pending = this.open(entry, key);
    this.pools.set(key, pending);
    try { return await pending; } catch (error) { this.pools.delete(key); throw error; }
  }

  public async closeAll(): Promise<void> {
    await Promise.all([...this.opened].map((connection) => connection.close()));
    this.opened.clear();
    this.pools.clear();
  }

  private async open(entry: TenantDirectoryEntry, key: string): Promise<TenantConnection> {
    assertTenantId(entry.tenantId);
    quoteIdentifier(entry.databaseName);
    quoteIdentifier(entry.username);
    const pool = mysql.createPool({
      host: entry.host,
      port: entry.port,
      user: entry.username,
      database: entry.databaseName,
      password: process.env[`OPSLOG_TENANT_SECRET_${entry.secretVersion}`],
      waitForConnections: true,
      connectionLimit: this.limits.perTenant,
      maxIdle: this.limits.perTenant,
      idleTimeout: this.limits.idleTimeoutMs ?? 60000,
      enableKeepAlive: true,
    });
    const connection: TenantConnection = {
      tenantId: entry.tenantId,
      databaseName: entry.databaseName,
      secretVersion: entry.secretVersion,
      pool,
      close: async () => { await pool.end(); this.opened.delete(connection); this.pools.delete(key); },
    };
    try {
      await pool.query('SELECT 1');
      this.opened.add(connection);
      return connection;
    } catch (error) {
      await pool.end();
      throw error;
    }
  }
}

export interface ProvisioningPlan {
  readonly tenantId: string;
  readonly databaseName: string;
  readonly username: string;
  readonly password: string;
  readonly host: string;
  readonly port: number;
  readonly secretVersion: string;
}

export interface Migration { readonly name: string; readonly sql: string; }

export interface ProvisioningResult { readonly databaseName: string; readonly migrationNames: readonly string[]; }

export async function provisionTenantDatabase(
  admin: PoolConnection,
  plan: ProvisioningPlan,
  migrations: readonly Migration[],
): Promise<ProvisioningResult> {
  assertTenantId(plan.tenantId);
  const engine = await inventoryMySqlEngine(admin);
  if (!/^8\./.test(engine.version)) throw new TenantAccessError('unsupported MySQL engine version');
  const database = quoteIdentifier(plan.databaseName);
  const username = quoteIdentifier(plan.username);
  await admin.query(`CREATE DATABASE IF NOT EXISTS ${database}`);
  await admin.query(`CREATE USER IF NOT EXISTS ${username}@'%' IDENTIFIED BY ?`, [plan.password]);
  await admin.query(`ALTER USER ${username}@'%' IDENTIFIED BY ?`, [plan.password]);
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${database}.* TO ${username}@'%'`);
  const migrationConnection = await mysql.createConnection({ host: plan.host, port: plan.port, user: plan.username, password: plan.password, database: plan.databaseName });
  try {
    await migrationConnection.query('CREATE TABLE IF NOT EXISTS opslog_schema_migrations (version VARCHAR(255) NOT NULL PRIMARY KEY) ENGINE=InnoDB');
    for (const migration of migrations) {
      const [rows] = await migrationConnection.execute<RowDataPacket[]>('SELECT version FROM opslog_schema_migrations WHERE version = ?', [migration.name]);
      if (rows.length > 0) continue;
      await migrationConnection.beginTransaction();
      try {
        await migrationConnection.query(migration.sql);
        await migrationConnection.execute<ResultSetHeader>('INSERT INTO opslog_schema_migrations (version) VALUES (?)', [migration.name]);
        await migrationConnection.commit();
      } catch (error) {
        await migrationConnection.rollback();
        throw error;
      }
    }
    await migrationConnection.query('SELECT 1');
    const [applied] = await migrationConnection.execute<RowDataPacket[]>('SELECT version FROM opslog_schema_migrations ORDER BY version');
    return { databaseName: plan.databaseName, migrationNames: applied.map((row) => String(row['version'])) };
  } finally {
    await migrationConnection.end();
  }
}

export interface EngineInventory { readonly version: string; readonly comment: string; readonly lowerCaseTableNames: number; }

export async function inventoryMySqlEngine(connection: PoolConnection | mysql.Connection): Promise<EngineInventory> {
  const [rows] = await connection.query<RowDataPacket[]>('SELECT VERSION() AS version, @@version_comment AS comment, @@lower_case_table_names AS lowerCaseTableNames');
  const row = rows[0];
  if (!row) throw new TenantAccessError('MySQL engine inventory returned no row');
  return { version: String(row['version']), comment: String(row['comment']), lowerCaseTableNames: Number(row['lowerCaseTableNames']) };
}
