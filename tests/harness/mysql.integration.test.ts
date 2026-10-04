import mysql from 'mysql2/promise';
import { describe, expect, it } from 'vitest';

const url = process.env.OPSLOG_TEST_MYSQL_URL;
if (!url)
  throw new Error('OPSLOG_TEST_MYSQL_URL is required; MySQL integration tests must not be skipped');
const adminUrl = new URL(url);
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
        await admin.query(
          `CREATE TABLE ${database}.opslog_harness_records (local_id INT NOT NULL PRIMARY KEY, value VARCHAR(64) NOT NULL)`,
        );
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
        await connections[0]!.execute(
          'INSERT INTO opslog_harness_records (local_id, value) VALUES (?, ?)',
          [2, 'rolled-back'],
        );
        await connections[0]!.rollback();
        const [afterRollback] = await connections[0]!.query(
          'SELECT local_id FROM opslog_harness_records WHERE local_id = 2',
        );
        const [untouchedB] = await connections[1]!.query(
          'SELECT local_id, value FROM opslog_harness_records',
        );
        expect(afterRollback).toEqual([]);
        expect(untouchedB).toEqual([{ local_id: 1, value: 'tenant-B' }]);
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
