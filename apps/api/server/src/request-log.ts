import type { BffHandler } from '../../bff/src/index.js';
import { routeOf, type Logger } from '../../../../packages/platform/observability/src/index.js';

/** Probes answered before the BFF; `/readyz` has its own failure line, `/healthz` is too frequent to log. */
const PROBE_PATHS = new Set(['/healthz', '/readyz']);

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
    try {
      const response = await handler(request);
      if (!PROBE_PATHS.has(request.url)) {
        logger[response.status >= 500 ? 'error' : 'info']('http_request', {
          route,
          status: response.status,
          durationMs: clock() - started,
          correlationId: header(response.headers, 'x-correlation-id'),
        });
      }
      return response;
    } catch (error) {
      logger.error('http_request_failed', {
        route,
        durationMs: clock() - started,
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
