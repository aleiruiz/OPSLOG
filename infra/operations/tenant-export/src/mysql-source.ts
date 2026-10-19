import mysql from 'mysql2/promise';
import type { Cell, ExportSource, Row, ServerInfo, TableMeta } from './types.js';
import { ExportError } from './types.js';
import { companyColumn, type RowScope } from './catalog.js';

export interface MysqlSourceConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

const IDENTIFIER = /^[A-Za-z0-9_]{1,64}$/;
const quote = (name: string): string => {
  // Names come from information_schema, but the check keeps a hostile schema from reaching a statement.
  if (!IDENTIFIER.test(name)) throw new ExportError('source_unavailable');
  return `\`${name}\``;
};

/** Converts a driver value to a JSON-safe cell: binary as base64, anything else as it came. */
function toCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value as Cell;
}

/**
 * Read-only view of one company database through the backup account (SELECT only). All reads happen
 * inside one REPEATABLE READ snapshot, so the archive is consistent even while the application writes.
 */
export class MysqlSource implements ExportSource {
  private constructor(
    private readonly connection: mysql.Connection,
    private readonly database: string,
    private readonly snapshot: ServerInfo,
  ) {}

  public static async open(config: MysqlSourceConfig): Promise<MysqlSource> {
    let connection: mysql.Connection;
    try {
      connection = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        // Text for dates and 64-bit integers: no precision lost, no time-zone conversion.
        dateStrings: true,
        supportBigNumbers: true,
        bigNumberStrings: true,
        multipleStatements: false,
      });
    } catch {
      throw new ExportError('source_unavailable');
    }
    try {
      await connection.query('SET SESSION TRANSACTION READ ONLY');
      await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
      const [rows] = await connection.query(
        "SELECT VERSION() AS version, @@server_uuid AS uuid, DATE_FORMAT(UTC_TIMESTAMP(3), '%Y-%m-%dT%H:%i:%s.%fZ') AS at",
      );
      const first = (rows as Record<string, string>[])[0] as Record<string, string>;
      const at = (first['at'] as string).replace(/(\.\d{3})\d*Z$/, '$1Z');
      return new MysqlSource(connection, config.database, {
        version: first['version'] as string,
        serverUuid: first['uuid'] as string,
        snapshotAt: at,
      });
    } catch {
      await connection.end().catch(() => undefined);
      throw new ExportError('source_unavailable');
    }
  }

  public async info(): Promise<ServerInfo> {
    return this.snapshot;
  }

  public async tables(): Promise<readonly TableMeta[]> {
    try {
      const [tables] = await this.connection.query(
        "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
        [this.database],
      );
      const [columns] = await this.connection.query(
        'SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION',
        [this.database],
      );
      const [keys] = await this.connection.query(
        "SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND INDEX_NAME = 'PRIMARY' ORDER BY TABLE_NAME, SEQ_IN_INDEX",
        [this.database],
      );
      const group = (list: unknown): Map<string, string[]> => {
        const map = new Map<string, string[]>();
        for (const row of list as { t: string; c: string }[])
          map.set(row.t, [...(map.get(row.t) ?? []), row.c]);
        return map;
      };
      const columnsOf = group(columns);
      const keysOf = group(keys);
      return (tables as { name: string }[]).map(({ name }) => ({
        name,
        columns: columnsOf.get(name) ?? [],
        primaryKey: keysOf.get(name) ?? [],
      }));
    } catch {
      throw new ExportError('source_unavailable');
    }
  }

  public async singleCompany(): Promise<{ id: string; name: string } | undefined> {
    try {
      const [rows] = await this.connection.query(
        "SELECT id, name FROM opslog_control_tenants WHERE status IN ('active', 'suspended')",
      );
      const list = rows as { id: string; name: string }[];
      return list.length === 1 ? (list[0] as { id: string; name: string }) : undefined;
    } catch {
      return undefined;
    }
  }

  /** `WHERE` of the company scope; the id is always a bound parameter. */
  private where(table: TableMeta, scope: RowScope): string {
    if (scope === 'tenant_record') return 'WHERE `id` = ?';
    if (scope === 'identity_of_company') {
      const key = table.columns.includes('identity_id') ? 'identity_id' : 'id';
      return `WHERE ${quote(key)} IN (SELECT \`identity_id\` FROM \`opslog_identity_memberships\` WHERE \`tenant_id\` = ?)`;
    }
    const column = companyColumn(table.columns);
    if (!column) throw new ExportError('unclassified_table');
    return `WHERE ${quote(column)} = ?`;
  }

  public async count(table: TableMeta, scope: RowScope, tenantId: string): Promise<number> {
    try {
      const [rows] = await this.connection.query(
        `SELECT COUNT(*) AS n FROM ${quote(table.name)} ${this.where(table, scope)}`,
        [tenantId],
      );
      return Number((rows as { n: string | number }[])[0]?.n ?? 0);
    } catch (error) {
      if (error instanceof ExportError) throw error;
      throw new ExportError('source_unavailable');
    }
  }

  public async *rows(table: TableMeta, scope: RowScope, tenantId: string): AsyncIterable<Row> {
    const order =
      table.primaryKey.length > 0 ? ` ORDER BY ${table.primaryKey.map(quote).join(', ')}` : '';
    const sql = this.connection.format(
      `SELECT * FROM ${quote(table.name)} ${this.where(table, scope)}${order}`,
      [tenantId],
    );
    // The callback API of the driver streams row by row with back-pressure; the promise wrapper buffers.
    const inner = (
      this.connection as unknown as {
        connection: { query(sql: string): { stream(): AsyncIterable<unknown> } };
      }
    ).connection;
    const query = inner.query(sql);
    try {
      for await (const raw of query.stream()) {
        const row: Row = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>))
          row[key] = toCell(value);
        yield row;
      }
    } catch {
      throw new ExportError('source_unavailable');
    }
  }

  public async close(): Promise<void> {
    try {
      await this.connection.query('ROLLBACK');
    } finally {
      await this.connection.end().catch(() => undefined);
    }
  }
}
