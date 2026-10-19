import type { Handler } from '../../base/src/index.js';
import { webhookHandlers, type HandlerDeps } from './handlers.js';

export * from './handlers.js';
export * from './jobs.js';
export type * from './ports.js';
export * from './registry.js';

/** Registers the public events on a registry shared with the other listeners of the outbox. */
export function registerWebhookHandlers(
  registry: { register(type: string, handler: Handler): void },
  deps: HandlerDeps,
): void {
  for (const [type, handler] of Object.entries(webhookHandlers(deps)))
    registry.register(type, handler);
}
