import type { WorkerRuntime } from '../../../worker/composition/src/index.js';

export interface WorkerLoop {
  /** Runs one tick now (the timer calls the same function); resolves when it finished. */
  tick(): Promise<void>;
  /** Stops the timers and resolves once a tick that was running has finished. */
  stop(): Promise<void>;
}

const TICK_MS = 5_000;

/**
 * Runs the worker in the API process: with in-memory adapters the outbox, scan queue and audit
 * relay live in this process, so a separate worker container could not see them. Each tick drains
 * the outbox, runs due scans and relays audit rows; a failing tick never stops the next one.
 */
export function startWorkerLoop(
  runtime: WorkerRuntime,
  report: (message: string) => void,
  tickMs = TICK_MS,
): WorkerLoop {
  let running: Promise<void> | undefined;
  const run = async (): Promise<void> => {
    try {
      await runtime.drainOutbox();
      await runtime.runScans();
      await runtime.runAuditRelay();
    } catch (error) {
      report(`worker_tick_failed ${error instanceof Error ? error.name : 'Error'}`);
    }
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
