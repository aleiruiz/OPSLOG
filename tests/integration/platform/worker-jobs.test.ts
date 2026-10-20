import { describe, expect, it } from 'vitest';
import {
  EXPORTS_PURGE_INTERVAL_MS,
  JobRegistry,
  exportsJobs,
  registerExportEventHandlers,
} from '../../../apps/worker/composition/src/index.js';

describe('JobRegistry', () => {
  it('keeps registration order and returns a copy', () => {
    const registry = new JobRegistry();
    registry.register({ name: 'outbox', run: async () => 1 });
    registry.register({ name: 'exports.run', run: async () => 2 });
    const list = registry.list();
    expect(list.map((job) => job.name)).toEqual(['outbox', 'exports.run']);
    (list as unknown[]).pop();
    expect(registry.list()).toHaveLength(2);
  });

  it('rejects duplicate and malformed names', () => {
    const registry = new JobRegistry();
    registry.register({ name: 'notify.send', run: async () => 0 });
    expect(() => registry.register({ name: 'notify.send', run: async () => 0 })).toThrow(
      /already registered/,
    );
    for (const name of ['', 'Bad', 'a b', '.x', 'x.', '1x'])
      expect(() => registry.register({ name, run: async () => 0 })).toThrow(/invalid job name/);
  });
});

describe('exports jobs', () => {
  const setup = (failFor?: string) => {
    const calls: string[] = [];
    const clock = { now: 1_000_000 };
    const jobs = exportsJobs({
      service: {
        runDue: async (tenantId) => {
          calls.push(`run:${tenantId}`);
          if (tenantId === failFor) throw new Error('boom');
          return 1;
        },
        purge: async (tenantId) => {
          calls.push(`purge:${tenantId}`);
          return 2;
        },
      },
      activeTenantIds: () => ['a', 'b'],
      clock: () => clock.now,
    });
    const named = (name: string) => jobs.find((job) => job.name === name)!;
    return { calls, clock, named };
  };

  it('runs every active company and sums what they produced', async () => {
    const { calls, named } = setup();
    expect(await named('exports.run').run()).toBe(2);
    expect(calls).toEqual(['run:a', 'run:b']);
  });

  it('tries every company before reporting the first failure', async () => {
    const { calls, named } = setup('a');
    await expect(named('exports.run').run()).rejects.toThrow('boom');
    expect(calls).toEqual(['run:a', 'run:b']);
  });

  it('purges at most once per interval', async () => {
    const { calls, clock, named } = setup();
    expect(await named('exports.purge').run()).toBe(4);
    expect(await named('exports.purge').run()).toBe(0);
    clock.now += EXPORTS_PURGE_INTERVAL_MS;
    expect(await named('exports.purge').run()).toBe(4);
    expect(calls.filter((call) => call.startsWith('purge:'))).toHaveLength(4);
  });

  it('registers a handler for both export events', async () => {
    const types: string[] = [];
    registerExportEventHandlers({ register: (type) => void types.push(type) });
    expect(types).toEqual(['export.completed', 'export.failed']);
  });
});
