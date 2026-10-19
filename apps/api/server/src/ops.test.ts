import { describe, expect, it } from 'vitest';
import { createOpsProbe } from './ops.js';

const endpoint = {
  host: 'mysql',
  port: 3306,
  database: 'opslog_t_main',
  account: { username: 'opslog_ops_app', password: 'pw' },
};
const expected = [
  { table: 'opslog_a_migrations', latest: '2026101900070' },
  { table: 'opslog_b_migrations', latest: '2026100600010' },
];

/** A connection that answers by the shape of the SQL; `fail` makes the query throw that MySQL code. */
function fakeConnect(options: {
  applied?: Record<string, string | null>;
  fail?: string;
  connectFails?: boolean;
  sql?: string[];
}) {
  return (async () => {
    if (options.connectFails)
      throw Object.assign(new Error('refused password=hunter2'), { code: 'ECONNREFUSED' });
    return {
      end: async () => undefined,
      query: async (sql: string) => {
        options.sql?.push(sql);
        if (options.fail) throw Object.assign(new Error('bad'), { code: options.fail });
        if (sql.includes('UNION ALL'))
          return [
            Object.entries(options.applied ?? {}).map(([migrationsTable, latest]) => ({
              migrationsTable,
              latest,
            })),
          ];
        if (sql.includes('opslog_tenant_outbox'))
          return [[{ pending: '4', dead: '1', lagSeconds: '12' }]];
        if (sql.includes('opslog_webhook_deliveries'))
          return [
            [
              { status: 'pending', total: 2 },
              { status: 'failed', total: 1 },
              { status: 'dead_letter', total: 3 },
            ],
          ];
        if (sql.includes('opslog_notification_deliveries'))
          return [
            [
              { status: 'pending', total: 5 },
              { status: 'failed', total: 2 },
            ],
          ];
        if (sql.includes('opslog_export_jobs'))
          return [
            [
              { status: 'queued', total: 1 },
              { status: 'completed', total: 7 },
            ],
          ];
        if (sql.includes('opslog_file_saga')) return [[{ total: 6 }]];
        return [[{ Variable_name: 'Threads_connected', Value: '9' }]];
      },
    };
  }) as never;
}

describe('createOpsProbe.readiness', () => {
  const applied = { opslog_a_migrations: '2026101900070', opslog_b_migrations: '2026100600010' };

  it('is ok when every migrations table is at the expected migration or newer', async () => {
    expect(await createOpsProbe(endpoint, expected, fakeConnect({ applied })).readiness()).toBe(
      'ok',
    );
    const newer = { ...applied, opslog_a_migrations: '2026102000001' };
    expect(
      await createOpsProbe(endpoint, expected, fakeConnect({ applied: newer })).readiness(),
    ).toBe('ok');
  });

  it('is migration_pending when a table is behind or empty, or a table is missing or unreadable', async () => {
    const behind = { ...applied, opslog_a_migrations: '2026100600010' };
    expect(
      await createOpsProbe(endpoint, expected, fakeConnect({ applied: behind })).readiness(),
    ).toBe('migration_pending');
    const empty = { ...applied, opslog_b_migrations: null };
    expect(
      await createOpsProbe(endpoint, expected, fakeConnect({ applied: empty })).readiness(),
    ).toBe('migration_pending');
    expect(
      await createOpsProbe(
        endpoint,
        expected,
        fakeConnect({ fail: 'ER_NO_SUCH_TABLE' }),
      ).readiness(),
    ).toBe('migration_pending');
    expect(
      await createOpsProbe(
        endpoint,
        expected,
        fakeConnect({ fail: 'ER_TABLEACCESS_DENIED_ERROR' }),
      ).readiness(),
    ).toBe('migration_pending');
  });

  it('is db_unreachable when the connection fails or the query fails for another reason', async () => {
    expect(
      await createOpsProbe(endpoint, expected, fakeConnect({ connectFails: true })).readiness(),
    ).toBe('db_unreachable');
    expect(
      await createOpsProbe(
        endpoint,
        expected,
        fakeConnect({ fail: 'PROTOCOL_CONNECTION_LOST' }),
      ).readiness(),
    ).toBe('db_unreachable');
    const weird = (async () => ({
      end: async () => undefined,
      query: async () => {
        throw 'plain string';
      },
    })) as never;
    expect(await createOpsProbe(endpoint, expected, weird).readiness()).toBe('db_unreachable');
  });

  it('only ever reads', async () => {
    const sql: string[] = [];
    await createOpsProbe(endpoint, expected, fakeConnect({ applied, sql })).readiness();
    expect(sql.every((statement) => statement.trimStart().startsWith('SELECT'))).toBe(true);
  });
});

describe('createOpsProbe.stats', () => {
  it('turns the queue tables into counters and treats a failed retry as pending', async () => {
    const sql: string[] = [];
    const stats = await createOpsProbe(endpoint, expected, fakeConnect({ sql })).stats();
    expect(stats).toEqual({
      outboxPending: 4,
      outboxLagSeconds: 12,
      outboxDeadLetter: 1,
      webhooksPending: 3,
      webhooksDeadLetter: 3,
      mailPending: 5,
      mailFailed: 2,
      exportsQueued: 1,
      exportsRunning: 0,
      exportsCompleted: 7,
      exportsFailed: 0,
      exportsExpired: 0,
      scanQueue: 6,
      dbConnections: 9,
    });
    expect(sql.every((statement) => /^\s*(SELECT|SHOW)/.test(statement))).toBe(true);
  });

  it('defaults to zero when a query returns no row, and surfaces a failure to the caller', async () => {
    const empty = (async () => ({ end: async () => undefined, query: async () => [[]] })) as never;
    const stats = await createOpsProbe(endpoint, expected, empty).stats();
    expect(Object.values(stats).every((value) => value === 0)).toBe(true);
    await expect(
      createOpsProbe(endpoint, expected, fakeConnect({ connectFails: true })).stats(),
    ).rejects.toThrow();
  });

  it('closes the connection even if closing fails', async () => {
    const broken = (async () => ({
      end: async () => {
        throw new Error('already closed');
      },
      query: async () => [[]],
    })) as never;
    await expect(createOpsProbe(endpoint, expected, broken).stats()).resolves.toBeDefined();
    await expect(createOpsProbe(endpoint, expected, broken).readiness()).resolves.toBe(
      'migration_pending',
    );
  });
});
