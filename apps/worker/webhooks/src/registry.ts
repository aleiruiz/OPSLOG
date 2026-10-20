import type { Handler } from '../../base/src/index.js';

export interface HandlerRegistry {
  register(type: string, handler: Handler): void;
}

/**
 * The outbox worker takes one handler per event type, but several modules listen to the same
 * events (a vehicle status change is a notice and a webhook). This registrar lets them share a
 * type: every handler runs, in the order registered, and the first failure is thrown once all have
 * run, so the outbox retries the event (all the handlers are idempotent) without one module
 * starving another.
 */
export function sharedRegistry(worker: HandlerRegistry): HandlerRegistry {
  const handlers = new Map<string, Handler[]>();
  return {
    register(type, handler) {
      const existing = handlers.get(type);
      if (existing) {
        existing.push(handler);
        return;
      }
      const list = [handler];
      handlers.set(type, list);
      worker.register(type, async (payload, event) => {
        let failure: unknown;
        let failed = false;
        for (const each of list) {
          try {
            await each(payload, event);
          } catch (error) {
            if (!failed) failure = error;
            failed = true;
          }
        }
        if (failed) throw failure;
      });
    },
  };
}
