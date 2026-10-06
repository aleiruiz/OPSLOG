import {
  AlertError,
  type Alert,
  type AlertListQuery,
  type AlertService,
} from '../../../../packages/domain/alerts/src/index.js';
import {
  AuthError,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';
import type { PlatformResponse } from './platform.js';

/** The deepest offset an alert listing may ask for (see the domain). */
export { MAX_ALERT_OFFSET } from '../../../../packages/domain/alerts/src/index.js';

export type AlertsApiErrorCode = 'invalid_input' | 'unauthorized' | 'forbidden' | 'internal_error';

const STATUS: Readonly<Record<AlertsApiErrorCode, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  internal_error: 500,
};

/**
 * Maps any failure to a safe payload: a code, its status and a generic message. Anything that is
 * not an `AlertError` or an `AuthError` (including store errors) is a plain 500.
 */
function failure(error: unknown): PlatformResponse<never> {
  let code: AlertsApiErrorCode = 'internal_error';
  if (error instanceof AlertError) {
    code = error.code;
  } else if (error instanceof AuthError) {
    code =
      error.code === 'unauthorized' || error.code === 'expired'
        ? 'unauthorized'
        : error.code === 'forbidden'
          ? 'forbidden'
          : error.code === 'invalid_input'
            ? 'invalid_input'
            : 'internal_error';
  }
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code],
      message: code === 'internal_error' ? 'Request failed' : `Alert request rejected: ${code}`,
    },
  };
}

/**
 * What the browser may know about an alert: ids, a type code and dates, never a title, a document
 * number, a policy number or a person. The company is never part of it.
 */
export type AlertView = Alert;

export interface AlertListView {
  readonly items: readonly AlertView[];
  readonly total: number;
  /** UTC date the alerts were derived for. */
  readonly asOf: string;
  /** The company's expiry window, in days. */
  readonly windowDays: number;
}

export interface AlertsApiDeps {
  readonly service: AlertService;
  /**
   * Authenticates the session (including the tenant gate), re-resolves the role and requires every
   * permission. The tenant of the returned context is the only one ever used.
   */
  readonly authorize: (
    token: string,
    correlationId: string,
    required: readonly Permission[],
  ) => Promise<TenantContext>;
}

/** Alerts are derived from documents and policies, which any reader may list, so reading needs `view`. */
export const ALERT_PERMISSIONS = { read: ['view'] } as const satisfies Record<
  string,
  readonly Permission[]
>;

/**
 * Expiry alert reads for the HTTP layer. Every call authenticates the session and re-resolves the
 * role (nothing is cached) and takes the tenant only from that session. Nothing is written, queued
 * or sent: alerts are derived from the database on every call.
 */
export class AlertsApi {
  public constructor(private readonly deps: AlertsApiDeps) {}

  public async list(
    token: string,
    correlationId: string,
    query: AlertListQuery,
  ): Promise<PlatformResponse<AlertListView & { tenantId: string }>> {
    try {
      const context = await this.deps.authorize(token, correlationId, ALERT_PERMISSIONS.read);
      const slice = await this.deps.service.list(context.tenantId, query);
      return {
        ok: true,
        value: {
          tenantId: context.tenantId,
          items: slice.items,
          total: slice.total,
          asOf: slice.asOf,
          windowDays: slice.windowDays,
        },
      };
    } catch (error) {
      return failure(error);
    }
  }
}
