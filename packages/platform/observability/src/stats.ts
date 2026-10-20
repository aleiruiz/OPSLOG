/**
 * The counters of the once-a-minute `ops_stats` line (NFR-M3). Counts and seconds only: nothing here
 * can carry a name, an identifier or a payload.
 */
export const OPS_STAT_KEYS = [
  'outboxPending',
  'outboxLagSeconds',
  'outboxDeadLetter',
  'webhooksPending',
  'webhooksDeadLetter',
  'mailPending',
  'mailFailed',
  'exportsQueued',
  'exportsRunning',
  'exportsCompleted',
  'exportsFailed',
  'exportsExpired',
  'scanQueue',
  'dbConnections',
  'workerAgeSeconds',
] as const;

export type OpsStatKey = (typeof OPS_STAT_KEYS)[number];
export type OpsStats = Readonly<Record<OpsStatKey, number>>;

/** Rows of a `SELECT status, COUNT(*)` as a lookup: a missing status counts zero. */
export function countsByStatus(rows: readonly { status: string; total: number | string }[]) {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.status, Number(row.total));
  return (...statuses: readonly string[]): number =>
    statuses.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0);
}
