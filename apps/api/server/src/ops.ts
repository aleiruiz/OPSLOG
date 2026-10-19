import mysql from 'mysql2/promise';
import {
  countsByStatus,
  type DatabaseOutcome,
  type OpsStats,
} from '../../../../packages/platform/observability/src/index.js';
import type { DbAccount, ExpectedMigration } from '../../composition/src/index.js';
import { AUDIT_TABLES } from '../../../../packages/persistence/audit/src/index.js';
import { EXPORT_TABLES } from '../../../../packages/persistence/exports/src/index.js';
import { FILE_TABLES } from '../../../../packages/persistence/files/src/index.js';
import { NOTIFICATION_TABLES } from '../../../../packages/persistence/notifications/src/index.js';
import { WEBHOOK_TABLES } from '../../../../packages/persistence/webhooks/src/index.js';

export interface OpsEndpoint {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly account: DbAccount;
}

/** Counters read from the database; `workerAgeSeconds` is added by the server from its heartbeat. */
export type DatabaseStats = Omit<OpsStats, 'workerAgeSeconds'>;

export interface OpsProbe {
  /** `ok` when MySQL answers to the probe account and every migrations table is at least as new as this build expects. */
  readiness(): Promise<DatabaseOutcome>;
  stats(): Promise<DatabaseStats>;
}

const CONNECT_TIMEOUT_MS = 3_000;
/** A table that is missing, or one the account cannot read, means the schema is not what this build expects. */
const SCHEMA_ERRORS = new Set(['ER_NO_SUCH_TABLE', 'ER_TABLEACCESS_DENIED_ERROR']);

const code = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

type Row = Record<string, unknown>;

/**
 * Probes the database with the SELECT-only `ops` account, one short connection per call (the health
 * check runs every few seconds; a pooled connection would sit idle against a small MySQL). Nothing
 * here writes, and no error text leaves this module: callers only see a code or a number.
 */
export function createOpsProbe(
  endpoint: OpsEndpoint,
  expected: readonly ExpectedMigration[],
  connect: typeof mysql.createConnection = mysql.createConnection,
): OpsProbe {
  const open = () =>
    connect({
      host: endpoint.host,
      port: endpoint.port,
      database: endpoint.database,
      user: endpoint.account.username,
      password: endpoint.account.password,
      connectTimeout: CONNECT_TIMEOUT_MS,
      timezone: 'Z',
    });
  const rows = async (
    connection: Awaited<ReturnType<typeof open>>,
    sql: string,
  ): Promise<Row[]> => {
    const [result] = await connection.query(sql);
    return result as Row[];
  };
  return {
    async readiness() {
      let connection: Awaited<ReturnType<typeof open>>;
      try {
        connection = await open();
      } catch {
        return 'db_unreachable';
      }
      try {
        const query = expected
          .map(
            (entry) =>
              `SELECT '${entry.table}' AS migrationsTable, CAST(MAX(\`timestamp\`) AS CHAR) AS latest FROM \`${entry.table}\``,
          )
          .join(' UNION ALL ');
        const applied = new Map(
          (await rows(connection, query)).map((row) => [
            String(row.migrationsTable),
            row.latest === null ? 0n : BigInt(String(row.latest)),
          ]),
        );
        return expected.every((entry) => (applied.get(entry.table) ?? 0n) >= BigInt(entry.latest))
          ? 'ok'
          : 'migration_pending';
      } catch (error) {
        return SCHEMA_ERRORS.has(code(error)) ? 'migration_pending' : 'db_unreachable';
      } finally {
        await connection.end().catch(() => undefined);
      }
    },
    async stats() {
      const connection = await open();
      try {
        const [outbox] = await rows(
          connection,
          `SELECT COALESCE(SUM(status IN ('pending','retry','processing')),0) AS pending,
                  COALESCE(SUM(status = 'dead_letter'),0) AS dead,
                  COALESCE(GREATEST(0, TIMESTAMPDIFF(SECOND,
                    MIN(CASE WHEN status IN ('pending','retry') THEN available_at END),
                    UTC_TIMESTAMP(3))),0) AS lagSeconds
             FROM \`${AUDIT_TABLES.outbox}\``,
        );
        const webhooks = countsByStatus(
          (await rows(
            connection,
            `SELECT status, COUNT(*) AS total FROM \`${WEBHOOK_TABLES.deliveries}\` GROUP BY status`,
          )) as never,
        );
        const mail = countsByStatus(
          (await rows(
            connection,
            `SELECT status, COUNT(*) AS total FROM \`${NOTIFICATION_TABLES.deliveries}\` WHERE channel = 'email' GROUP BY status`,
          )) as never,
        );
        const exportJobs = countsByStatus(
          (await rows(
            connection,
            `SELECT status, COUNT(*) AS total FROM \`${EXPORT_TABLES.jobs}\` GROUP BY status`,
          )) as never,
        );
        const [scans] = await rows(
          connection,
          `SELECT COUNT(*) AS total FROM \`${FILE_TABLES.saga}\` WHERE stage = 'scan' AND state IN ('pending','processing','retry')`,
        );
        const [threads] = await rows(connection, `SHOW GLOBAL STATUS LIKE 'Threads_connected'`);
        return {
          outboxPending: Number(outbox?.pending ?? 0),
          outboxLagSeconds: Number(outbox?.lagSeconds ?? 0),
          outboxDeadLetter: Number(outbox?.dead ?? 0),
          // `failed` is a delivery waiting for its next retry, so it counts as pending.
          webhooksPending: webhooks('pending', 'failed'),
          webhooksDeadLetter: webhooks('dead_letter'),
          mailPending: mail('pending'),
          mailFailed: mail('failed'),
          exportsQueued: exportJobs('queued'),
          exportsRunning: exportJobs('running'),
          exportsCompleted: exportJobs('completed'),
          exportsFailed: exportJobs('failed'),
          exportsExpired: exportJobs('expired'),
          scanQueue: Number(scans?.total ?? 0),
          dbConnections: Number(threads?.Value ?? 0),
        };
      } finally {
        await connection.end().catch(() => undefined);
      }
    },
  };
}
