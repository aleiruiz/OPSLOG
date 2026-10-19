import type { Handler } from '../../base/src/index.js';
import { notificationHandlers, slaNoticeHandler, EVENTS, type HandlerDeps } from './handlers.js';

export * from './handlers.js';
export * from './jobs.js';
export type * from './ports.js';

/**
 * Registers the handlers of the events that only this module listens to. `incident.sla_alert`
 * already has INC-SLA's handler (one per type): use `withSlaNotice` to run both.
 */
export function registerNotificationHandlers(
  worker: { register(type: string, handler: Handler): void },
  deps: HandlerDeps,
): void {
  for (const [type, handler] of Object.entries(notificationHandlers(deps)))
    worker.register(type, handler);
}

/**
 * A worker that runs the in-app notice of an INC-SLA alert next to INC-SLA's own handler. The
 * e-mail handler runs first and always; a failure of the notice is thrown afterwards so the outbox
 * retries the event (both sides are idempotent) without ever skipping the e-mail.
 */
export function withSlaNotice(
  worker: { register(type: string, handler: Handler): void },
  deps: HandlerDeps,
): { register(type: string, handler: Handler): void } {
  const notice = slaNoticeHandler(deps);
  return {
    register(type, handler) {
      if (type !== EVENTS.slaAlert) return worker.register(type, handler);
      worker.register(type, async (payload, event) => {
        let failure: unknown;
        await Promise.resolve(notice(payload, event)).catch((error: unknown) => {
          failure = error;
        });
        await handler(payload, event);
        if (failure !== undefined) throw failure;
      });
    },
  };
}
