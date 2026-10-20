import { describe, expect, it } from 'vitest';
import {
  checkReadiness,
  readinessResponse,
  WORKER_MAX_AGE_MS,
  WorkerHeartbeat,
  type ReadinessChecks,
} from './readiness.js';

describe('WorkerHeartbeat', () => {
  it('is fresh at start and goes stale after the maximum age without a beat', () => {
    let now = 1_000;
    const heartbeat = new WorkerHeartbeat(() => now);
    expect(heartbeat.fresh()).toBe(true);
    now += WORKER_MAX_AGE_MS - 1;
    expect(heartbeat.fresh()).toBe(true);
    now += 1;
    expect(heartbeat.fresh()).toBe(false);
    heartbeat.beat();
    expect(heartbeat.ageMs()).toBe(0);
    expect(heartbeat.fresh()).toBe(true);
  });

  it('never reports a negative age if the clock steps back', () => {
    let now = 5_000;
    const heartbeat = new WorkerHeartbeat(() => now);
    now = 1_000;
    expect(heartbeat.ageMs()).toBe(0);
  });

  it('defaults to the system clock', () => {
    expect(new WorkerHeartbeat().fresh()).toBe(true);
  });
});

describe('checkReadiness', () => {
  const fresh = (): WorkerHeartbeat => new WorkerHeartbeat(() => 0);
  const stale = (): WorkerHeartbeat => {
    let now = 0;
    const heartbeat = new WorkerHeartbeat(() => now);
    now = WORKER_MAX_AGE_MS + 1;
    return heartbeat;
  };

  it('is ready with nothing to check, and with every check green', async () => {
    expect(await checkReadiness({})).toEqual({ ready: true });
    const checks: ReadinessChecks = { database: async () => 'ok', worker: fresh() };
    expect(await checkReadiness(checks)).toEqual({ ready: true });
  });

  it('reports the database first, then migrations, then the worker', async () => {
    expect(
      await checkReadiness({ database: async () => 'db_unreachable', worker: stale() }),
    ).toEqual({ ready: false, code: 'db_unreachable' });
    expect(
      await checkReadiness({ database: async () => 'migration_pending', worker: stale() }),
    ).toEqual({ ready: false, code: 'migration_pending' });
    expect(await checkReadiness({ database: async () => 'ok', worker: stale() })).toEqual({
      ready: false,
      code: 'worker_stalled',
    });
  });

  it('treats a throwing database check as unreachable without leaking the error', async () => {
    const result = await checkReadiness({
      database: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:3306 password=hunter2');
      },
    });
    expect(result).toEqual({ ready: false, code: 'db_unreachable' });
  });
});

describe('readinessResponse', () => {
  it('answers 200 or 503 with only a code', () => {
    expect(readinessResponse({ ready: true })).toMatchObject({
      status: 200,
      body: '{"status":"ready"}',
    });
    const down = readinessResponse({ ready: false, code: 'worker_stalled' });
    expect(down.status).toBe(503);
    expect(JSON.parse(down.body)).toEqual({ status: 'unready', code: 'worker_stalled' });
    expect(down.headers['cache-control']).toBe('no-store');
  });
});
