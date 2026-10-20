import type { WorkerRuntime } from '../../../worker/composition/src/index.js';
import type {
  Logger,
  WorkerHeartbeat,
} from '../../../../packages/platform/observability/src/index.js';

export interface WorkerLoop {
  /** Runs one tick now (the timer calls the same function); resolves when it finished. */
  tick(): Promise<void>;
  /** Stops the timers and resolves once a tick that was running has finished. */
  stop(): Promise<void>;
}

const TICK_MS = 5_000;

/**
 * Runs the worker in the API process: with in-memory adapters the outbox, scan queue and audit
 * relay live in this process, so a separate worker container could not see them. Each tick walks the
 * registered jobs in order (outbox, scans, audit relay, then each module's own, such as exports);
 * a failing job never stops the next one, nor the next tick. A tick that finishes beats the
 * heartbeat that `/readyz` reads, so a tick that hangs makes the service report `worker_stalled`.
 */
export function startWorkerLoop(
  runtime: WorkerRuntime,
  logger: Logger,
  heartbeat?: WorkerHeartbeat,
  tickMs = TICK_MS,
): WorkerLoop {
  let running: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    // Each registered job runs on its own: one that fails is reported by name and the rest still run.
    for (const job of runtime.jobs.list()) {
      try {
        await job.run();
      } catch (error) {
        logger.error('worker_job_failed', {
          job: job.name,
          errorClass: error instanceof Error ? error.constructor.name : 'Error',
        });
      }
    }
    heartbeat?.beat();
  };
  const tick = (): Promise<void> => {
    if (running) return running;
    const current = run().finally(() => {
      running = undefined;
    });
    running = current;
    return current;
  };
  runtime.periodic.start();
  const handle = setInterval(() => void tick(), tickMs);
  handle.unref();
  return {
    tick,
    stop: async () => {
      clearInterval(handle);
      runtime.periodic.stop();
      await running;
    },
  };
}
