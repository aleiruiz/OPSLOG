import { AsyncLocalStorage } from 'node:async_hooks';
import type { BffHandler } from '../../bff/src/index.js';
import {
  opaqueRef,
  routeOf,
  type Logger,
} from '../../../../packages/platform/observability/src/index.js';

/** Probes answered before the BFF; `/readyz` has its own failure line, `/healthz` is too frequent to log. */
const PROBE_PATHS = new Set(['/healthz', '/readyz']);

const scope = new AsyncLocalStorage<{ actorRef?: string }>();

/**
 * Called by the BFF once the session is resolved. Stores only the opaque reference (`a_` + hash of
 * tenant and identity) for the request in flight; the raw ids, e-mail, name or subject never reach
 * the logger. Outside a logged request it does nothing.
 */
export function exposeActor(identity: { tenantId: string; identityId: string }): void {
  const store = scope.getStore();
  if (store) store.actorRef = opaqueRef('a', `${identity.tenantId}:${identity.identityId}`);
}

/**
 * One line per request with the static route, the status, the duration and the correlation id the
 * BFF put on the response. The query string, headers, cookies and body never reach the logger; the
 * route keeps only plain words and replaces every identifier with `:id`.
 */
export function withRequestLog(
  handler: BffHandler,
  logger: Logger,
  clock: () => number = Date.now,
): BffHandler {
  return async (request) => {
    const started = clock();
    const route = routeOf(request.method, request.url);
    const state: { actorRef?: string } = {};
    try {
      const response = await scope.run(state, () => handler(request));
      if (!PROBE_PATHS.has(request.url)) {
        logger[response.status >= 500 ? 'error' : 'info']('http_request', {
          route,
          status: response.status,
          durationMs: clock() - started,
          correlationId: header(response.headers, 'x-correlation-id'),
          actorRef: state.actorRef,
        });
      }
      return response;
    } catch (error) {
      logger.error('http_request_failed', {
        route,
        durationMs: clock() - started,
        actorRef: state.actorRef,
        errorClass: error instanceof Error ? error.constructor.name : 'Error',
      });
      throw error;
    }
  };
}

function header(headers: Readonly<Record<string, unknown>>, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}
