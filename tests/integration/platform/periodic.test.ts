import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PeriodicScheduler,
  type PeriodicTimers,
} from '../../../apps/worker/composition/src/index.js';
import {
  INCIDENT_SLA_SCAN_JOB,
  MAINTENANCE_PLAN_SCAN_JOB,
} from '../../../apps/api/composition/src/platform/runtime.js';
import { InMemoryMaintenancePlanStore } from '../../../packages/domain/maintenance/plans/src/index.js';
import {
  DEFAULT_PLAN_SCAN_INTERVAL_MS,
  DEFAULT_SEARCH_RECONCILE_INTERVAL_MS,
  DEFAULT_SLA_SCAN_INTERVAL_MS,
} from '../../../apps/worker/composition/src/index.js';
import { createWorld, type World } from './world.js';

let world: World | undefined;
afterEach(() => world?.dispose());

type Status = 'active' | 'suspended' | 'missing';
const directory = (statuses: Record<string, Status>) => ({
  ids: () => Object.keys(statuses),
  status: (id: string): Status => statuses[id] ?? 'missing',
});

describe('periodic scheduler', () => {
  it('queues the job once per active tenant and does not let one failure stop the others', async () => {
    const queued: string[] = [];
    const scheduler = new PeriodicScheduler(
      directory({ a: 'active', b: 'suspended', c: 'active', d: 'active' }),
      [
        {
          name: 'job',
          intervalMs: 1000,
          enqueue: async (tenantId) => {
            if (tenantId === 'c') throw new Error('outbox down');
            queued.push(tenantId);
          },
        },
      ],
    );
    expect(await scheduler.tick('job')).toEqual({ enqueued: 2, failed: 1 });
    expect(queued).toEqual(['a', 'd']);
    await expect(scheduler.tick('other')).rejects.toThrow('unknown periodic job');
  });

  it('skips a tick while the previous one still runs', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const scheduler = new PeriodicScheduler(directory({ a: 'active' }), [
      {
        name: 'job',
        intervalMs: 1000,
        enqueue: async () => {
          calls += 1;
          await gate;
        },
      },
    ]);
    const first = scheduler.tick('job');
    expect(await scheduler.tick('job')).toEqual({ enqueued: 0, failed: 0 });
    release();
    expect(await first).toEqual({ enqueued: 1, failed: 0 });
    expect(calls).toBe(1);
  });

  it('starts once on its interval, stops cleanly and rejects a too short interval', () => {
    const live = new Map<number, () => void>();
    let next = 0;
    const timers: PeriodicTimers = {
      set: (run) => {
        next += 1;
        live.set(next, run);
        return next;
      },
      clear: (handle) => void live.delete(handle as number),
    };
    const scheduler = new PeriodicScheduler(
      directory({}),
      [{ name: 'job', intervalMs: 1000, enqueue: async () => undefined }],
      timers,
    );
    expect(scheduler.started).toBe(false);
    scheduler.start();
    scheduler.start();
    expect(scheduler.started).toBe(true);
    expect(live.size).toBe(1);
    live.get(1)?.();
    scheduler.stop();
    expect(live.size).toBe(0);
    expect(scheduler.started).toBe(false);
    expect(
      () =>
        new PeriodicScheduler(directory({}), [
          { name: 'x', intervalMs: 10, enqueue: async () => undefined },
        ]),
    ).toThrow('at least one second');
  });

  it('runs on the real timer without keeping the process alive', async () => {
    const queued: string[] = [];
    const scheduler = new PeriodicScheduler(directory({ a: 'active' }), [
      {
        name: 'job',
        intervalMs: 1000,
        enqueue: async (tenantId) => void queued.push(tenantId),
      },
    ]);
    scheduler.start();
    scheduler.stop();
    expect(queued).toEqual([]);
  });
});

describe('periodic incident SLA scan of the composition', () => {
  it('queues one scan per active tenant in its own outbox and the worker drains it', async () => {
    world = createWorld({ worker: { slaScanIntervalMs: 60_000 } });
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    const c = await world.tenant('Empresa Gamma', 'subject-admin-c');
    await platform.suspendTenant(b.tenantId);

    expect(await platform.runtime.periodic.tick(INCIDENT_SLA_SCAN_JOB)).toEqual({
      enqueued: 2,
      failed: 0,
    });
    const scans = world.outbox.all().filter((record) => record.type === 'incident.sla.scan');
    expect(scans.map((record) => record.tenantId).sort()).toEqual([a.tenantId, c.tenantId].sort());
    expect(scans.every((record) => JSON.stringify(record.payload) === '{}')).toBe(true);
    await platform.runtime.drainOutbox();
    expect(
      world.outbox
        .all()
        .filter((record) => record.type === 'incident.sla.scan')
        .map((record) => record.status),
    ).toEqual(['delivered', 'delivered']);
  });
});

describe('periodic maintenance plan scan of the composition', () => {
  /** A plan store that can scan (as the MySQL one does) and records the periodic enqueue. */
  class ScanningPlanStore extends InMemoryMaintenancePlanStore {
    public readonly enqueued: { tenantId: string; now: Date }[] = [];
    public failWith: Error | undefined;
    public async enqueueScans(tenantId: string, now: Date): Promise<number> {
      if (this.failWith) throw this.failWith;
      this.enqueued.push({ tenantId, now });
      return 0;
    }
    public scan = async () => [];
    public closePreventive = async () => undefined;
    public reopenPreventive = async () => undefined;
    public cancelPreventive = async () => undefined;
    public adoptPreventive = async () => undefined;
    public baselineBeforeClosure = async () => null;
  }

  it('registers no plan scan job when the plan store cannot scan (in memory)', async () => {
    world = createWorld();
    await expect(world.platform.runtime.periodic.tick(MAINTENANCE_PLAN_SCAN_JOB)).rejects.toThrow(
      'unknown periodic job',
    );
  });

  it('lists the plan scan next to the SLA scan, hourly by default, and queues it per active tenant', async () => {
    const store = new ScanningPlanStore();
    world = createWorld({ adapters: { maintenancePlans: store } });
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    await world.platform.suspendTenant(b.tenantId);

    expect(DEFAULT_PLAN_SCAN_INTERVAL_MS).toBe(3_600_000);
    expect(await world.platform.runtime.periodic.tick(MAINTENANCE_PLAN_SCAN_JOB)).toEqual({
      enqueued: 1,
      failed: 0,
    });
    expect(store.enqueued.map((call) => call.tenantId)).toEqual([a.tenantId]);

    store.failWith = new Error('outbox down');
    expect(await world.platform.runtime.periodic.tick(MAINTENANCE_PLAN_SCAN_JOB)).toEqual({
      enqueued: 0,
      failed: 1,
    });
  });

  it('schedules the plan scan hourly by default and on worker.planScanIntervalMs when given', () => {
    const intervals = (options: Parameters<typeof createWorld>[0]): unknown[] => {
      world = createWorld({ adapters: { maintenancePlans: new ScanningPlanStore() }, ...options });
      const spy = vi.spyOn(globalThis, 'setInterval');
      world.platform.runtime.periodic.start();
      world.platform.runtime.periodic.stop();
      const used = spy.mock.calls.map((call) => call[1]);
      spy.mockRestore();
      world.dispose();
      return used;
    };
    expect(intervals({})).toEqual([
      DEFAULT_SLA_SCAN_INTERVAL_MS,
      DEFAULT_PLAN_SCAN_INTERVAL_MS,
      DEFAULT_SEARCH_RECONCILE_INTERVAL_MS,
    ]);
    expect(intervals({ worker: { planScanIntervalMs: 2_000 } })).toEqual([
      DEFAULT_SLA_SCAN_INTERVAL_MS,
      2_000,
      DEFAULT_SEARCH_RECONCILE_INTERVAL_MS,
    ]);
    expect(intervals({ worker: { searchReconcileIntervalMs: 5_000 } })).toEqual([
      DEFAULT_SLA_SCAN_INTERVAL_MS,
      DEFAULT_PLAN_SCAN_INTERVAL_MS,
      5_000,
    ]);
  });
});
