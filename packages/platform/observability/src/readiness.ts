/** Why the service is not ready; the code is all a caller ever sees. */
export type NotReadyCode = 'db_unreachable' | 'migration_pending' | 'worker_stalled';

/** What the database check can say; `worker_stalled` comes from the heartbeat. */
export type DatabaseOutcome = 'ok' | Exclude<NotReadyCode, 'worker_stalled'>;

export type ReadinessResult =
  | { readonly ready: true }
  | { readonly ready: false; readonly code: NotReadyCode };

/** The worker has to finish a tick at least this often (task MVP-OPS-M5, `readyz`). */
export const WORKER_MAX_AGE_MS = 60_000;

/** Records when the in-process worker last finished a tick. */
export class WorkerHeartbeat {
  private last: number;
  public constructor(private readonly clock: () => number = Date.now) {
    // The loop has not ticked yet at start-up; the first tick is due within one interval.
    this.last = clock();
  }
  public beat(): void {
    this.last = this.clock();
  }
  public ageMs(): number {
    return Math.max(0, this.clock() - this.last);
  }
  public fresh(maxAgeMs = WORKER_MAX_AGE_MS): boolean {
    return this.ageMs() < maxAgeMs;
  }
}

export interface ReadinessChecks {
  /** Database reachable with a runtime account, and the last migration applied; undefined when there is none (memory). */
  readonly database?: () => Promise<DatabaseOutcome>;
  /** Absent when the worker is not running (read-only mode). */
  readonly worker?: WorkerHeartbeat;
}

/** Runs the checks in a fixed order (database, migrations, worker); the first failure is the answer. */
export async function checkReadiness(checks: ReadinessChecks): Promise<ReadinessResult> {
  if (checks.database) {
    let outcome: DatabaseOutcome;
    try {
      outcome = await checks.database();
    } catch {
      outcome = 'db_unreachable';
    }
    if (outcome !== 'ok') return { ready: false, code: outcome };
  }
  if (checks.worker && !checks.worker.fresh()) return { ready: false, code: 'worker_stalled' };
  return { ready: true };
}

export interface ProbeResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** `200 {"status":"ready"}` or `503 {"status":"unready","code":"..."}`: no detail beyond the code. */
export function readinessResponse(result: ReadinessResult): ProbeResponse {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  return result.ready
    ? { status: 200, headers, body: '{"status":"ready"}' }
    : { status: 503, headers, body: JSON.stringify({ status: 'unready', code: result.code }) };
}
