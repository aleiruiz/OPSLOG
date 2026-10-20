import { afterEach, describe, expect, it } from 'vitest';
import { startWorkerLoop } from '../../../apps/api/server/src/worker-loop.js';
import { createLogger } from '../../../packages/platform/observability/src/index.js';
import { createWorld, type World } from './world.js';

let world: World;
afterEach(() => world.dispose());

/** The jobs the api process walks on every tick, in order (MVP-INTEGRATE, alcance 2). */
const TICK_JOBS = [
  'outbox',
  'scans',
  'audit-relay',
  'exports.run',
  'exports.purge',
  'notifications.dispatch',
  'notifications.scan',
  'webhooks.dispatch',
  'webhooks.eligibility',
  'webhooks.purge',
];

describe('worker tick of the api process', () => {
  it('registers every job of M5 in tick order', async () => {
    world = createWorld();
    const { runtime } = world.platform;
    expect(runtime.jobs.list().map((job) => job.name)).toEqual(TICK_JOBS);
    // Plans, SLA and the search projection exist only with MySQL persistence (see periodic.test.ts and the
    // journeys in tests/e2e/mvp); without them a name is refused instead of silently skipped.
    await expect(runtime.periodic.tick('no.such.job')).rejects.toThrow('unknown periodic job');
  });

  it('runs every job each tick and one failing job does not stop the others', async () => {
    world = createWorld();
    const { runtime } = world.platform;
    const ran: string[] = [];
    for (const job of runtime.jobs.list()) {
      const original = job.run.bind(job);
      (job as { run: () => Promise<unknown> }).run = async () => {
        ran.push(job.name);
        // The outbox and a module job in the middle both fail.
        if (job.name === 'outbox' || job.name === 'notifications.scan')
          throw new Error('synthetic failure');
        return original();
      };
    }
    const lines: string[] = [];
    const loop = startWorkerLoop(
      runtime,
      createLogger((line) => lines.push(line)),
    );
    try {
      await loop.tick();
      expect(ran).toEqual(TICK_JOBS);
      await loop.tick();
      expect(ran).toEqual([...TICK_JOBS, ...TICK_JOBS]);
    } finally {
      await loop.stop();
    }
    const failed = lines.map((line) => JSON.parse(line) as { msg: string; job: string });
    expect(failed.filter((entry) => entry.msg === 'worker_job_failed').map((e) => e.job)).toEqual([
      'outbox',
      'notifications.scan',
      'outbox',
      'notifications.scan',
    ]);
    expect(lines.join('')).not.toContain('synthetic failure');
  });
});
