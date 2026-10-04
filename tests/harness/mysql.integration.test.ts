import mysql from 'mysql2/promise';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const adminUrlValue = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
if (!adminUrlValue)
  throw new Error(
    'OPSLOG_TEST_MYSQL_ADMIN_URL is required; MySQL integration tests must not be skipped',
  );
const adminUrl = new URL(adminUrlValue);
const adminConfig = {
  host: adminUrl.hostname,
  port: Number(adminUrl.port || 3306),
  user: decodeURIComponent(adminUrl.username) || 'root',
  password: decodeURIComponent(adminUrl.password),
};
const suffix = `${Date.now()}_${process.pid}`;
const databases = [`opslog_a_${suffix}`, `opslog_b_${suffix}`];
const users = [`opslog_a_${suffix}`, `opslog_b_${suffix}`];
const password = `test_${suffix}`;

function identifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `\`${value}\``;
}

async function applyMigrations(connection: mysql.Connection): Promise<void> {
  const migrationDirectory = join(process.cwd(), 'tests', 'harness', 'migrations');
  const migrations = (await readdir(migrationDirectory))
    .filter((file) => /^\d+_.*\.sql$/.test(file))
    .sort();
  await connection.query(
    'CREATE TABLE IF NOT EXISTS opslog_schema_migrations (version VARCHAR(255) NOT NULL PRIMARY KEY)',
  );
  for (const migration of migrations) {
    const [applied] = await connection.execute(
      'SELECT version FROM opslog_schema_migrations WHERE version = ?',
      [migration],
    );
    if ((applied as mysql.RowDataPacket[]).length > 0) continue;
    await connection.beginTransaction();
    try {
      await connection.query(await readFile(join(migrationDirectory, migration), 'utf8'));
      await connection.execute('INSERT INTO opslog_schema_migrations (version) VALUES (?)', [
        migration,
      ]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  }
}

describe('synthetic MySQL tenant isolation', () => {
  it('migrates two isolated databases, rolls back A, and handles concurrent A/B work', async () => {
    const admin = await mysql.createConnection(adminConfig);
    try {
      for (const database of databases)
        await admin.query(`CREATE DATABASE ${identifier(database)}`);
      for (let index = 0; index < databases.length; index += 1) {
        const database = identifier(databases[index]!);
        const user = users[index]!;
        await admin.query(`CREATE USER ${identifier(user)}@'%' IDENTIFIED BY ?`, [password]);
        await admin.query(`GRANT ALL PRIVILEGES ON ${database}.* TO ${identifier(user)}@'%'`);
      }
      const connections = await Promise.all(
        databases.map((database, index) =>
          mysql.createConnection({
            host: adminConfig.host,
            port: adminConfig.port,
            user: users[index]!,
            password,
            database,
          }),
        ),
      );
      try {
        await Promise.all(connections.map(applyMigrations));
        const [migrationRows] = await connections[0]!.query(
          'SELECT version FROM opslog_schema_migrations ORDER BY version',
        );
        expect(migrationRows).toEqual([
          { version: '001_initial.sql' },
          { version: '002_add_updated_at.sql' },
        ]);
        await Promise.all(
          connections.map((connection, index) =>
            connection.execute(
              'INSERT INTO opslog_harness_records (local_id, value) VALUES (?, ?)',
              [1, `tenant-${index === 0 ? 'A' : 'B'}`],
            ),
          ),
        );
        const [rowsA] = await connections[0]!.query(
          'SELECT local_id, value FROM opslog_harness_records',
        );
        const [rowsB] = await connections[1]!.query(
          'SELECT local_id, value FROM opslog_harness_records',
        );
        expect(rowsA).toEqual([{ local_id: 1, value: 'tenant-A' }]);
        expect(rowsB).toEqual([{ local_id: 1, value: 'tenant-B' }]);
        await connections[0]!.beginTransaction();
        await connections[1]!.beginTransaction();
        await connections[0]!.execute(
          'UPDATE opslog_harness_records SET value = ?, version = version + 1 WHERE local_id = ?',
          ['A-interleaved', 1],
        );
        await connections[1]!.execute(
          'UPDATE opslog_harness_records SET value = ?, version = version + 1 WHERE local_id = ?',
          ['B-interleaved', 1],
        );
        await connections[1]!.commit();
        await connections[0]!.rollback();
        const [afterRollback] = await connections[0]!.query(
          'SELECT local_id FROM opslog_harness_records WHERE local_id = 2',
        );
        const [untouchedB] = await connections[1]!.query(
          'SELECT local_id, value FROM opslog_harness_records',
        );
        expect(afterRollback).toEqual([]);
        expect(untouchedB).toEqual([{ local_id: 1, value: 'B-interleaved' }]);
      } finally {
        await Promise.all(connections.map((connection) => connection.end()));
      }
    } finally {
      for (const user of users) await admin.query(`DROP USER IF EXISTS ${identifier(user)}@'%'`);
      for (const database of databases)
        await admin.query(`DROP DATABASE IF EXISTS ${identifier(database)}`);
      await admin.end();
    }
  });
});
