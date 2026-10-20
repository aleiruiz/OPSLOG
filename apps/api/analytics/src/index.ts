import { createHash } from 'node:crypto';
import {
  AnalyticsError,
  type Dashboard,
  type DashboardQuery,
  type DashboardService,
} from '../../../../packages/domain/analytics/src/index.js';
import {
  AuthError,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';

/** Same shape as the composition's response (`DashboardApiResponse`), declared here to keep the layers apart. */
export interface DashboardApiResponse<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code: string; readonly status: number; readonly message: string };
}

export type DashboardApiErrorCode =
  | 'invalid_input'
  | 'invalid_area'
  | 'unauthorized'
  | 'forbidden'
  | 'internal_error';

const STATUS: Readonly<Record<DashboardApiErrorCode, number>> = {
  invalid_input: 400,
  invalid_area: 422,
  unauthorized: 401,
  forbidden: 403,
  internal_error: 500,
};

/** How long a computed dashboard is reused (SPECS: cache of 5 minutes per company, reader and filters). */
export const DASHBOARD_CACHE_TTL_MS = 5 * 60_000;
/** The cache holds at most this many entries; the oldest go first. */
export const DASHBOARD_CACHE_MAX_ENTRIES = 256;

/** Any failure becomes a code, its status and a generic text: no value of the request, no store error. */
function failure(error: unknown): DashboardApiResponse<never> {
  let code: DashboardApiErrorCode = 'internal_error';
  if (error instanceof AnalyticsError) code = error.code;
  else if (error instanceof AuthError)
    code =
      error.code === 'unauthorized' || error.code === 'expired'
        ? 'unauthorized'
        : error.code === 'forbidden'
          ? 'forbidden'
          : error.code === 'invalid_input'
            ? 'invalid_input'
            : 'internal_error';
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code],
      message: code === 'internal_error' ? 'Request failed' : `Dashboard request rejected: ${code}`,
    },
  };
}

/**
 * Authorization version of a reader: a digest of the permissions that decide which widgets they see.
 * Two readers with the same permissions share it; a grant or a revocation changes it at once, so a
 * cached dashboard is never served to a reader whose rights differ from the ones it was built for.
 */
export function authorizationVersion(permissions: readonly Permission[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...new Set(permissions)].sort()))
    .digest('hex')
    .slice(0, 32);
}

export interface DashboardApiDeps {
  readonly service: DashboardService;
  /** Authenticates the session (tenant gate included) and re-resolves the reader's permissions now. */
  readonly authorize: (
    token: string,
    correlationId: string,
  ) => Promise<{ readonly context: TenantContext; readonly permissions: readonly Permission[] }>;
  readonly now: () => Date;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}

interface Entry {
  readonly expiresAt: number;
  readonly value: Dashboard;
}

/**
 * `GET /api/v1/dashboard`. Every call authenticates and re-resolves the permissions (nothing about
 * the reader is cached), and only the figures are reused: the key holds the company, the reader's
 * authorization version and the resolved filters, so the cache never crosses a company, a permission
 * change or a filter. Concurrent identical requests share one computation; failures are not cached.
 */
export class DashboardApi {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Dashboard>>();

  public constructor(private readonly deps: DashboardApiDeps) {}

  public async get(
    token: string,
    correlationId: string,
    query: DashboardQuery,
  ): Promise<DashboardApiResponse<Dashboard>> {
    try {
      const { context, permissions } = await this.deps.authorize(token, correlationId);
      const tenantId = context.tenantId;
      const resolved = await this.deps.service.resolve(tenantId, query);
      const key = JSON.stringify([tenantId, authorizationVersion(permissions), resolved]);
      const now = this.deps.now().getTime();
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > now) return { ok: true, value: hit.value };
      let pending = this.inflight.get(key);
      if (!pending) {
        pending = this.deps.service
          .compute(tenantId, resolved, permissions)
          .then((value) => {
            this.store(key, {
              expiresAt: now + (this.deps.ttlMs ?? DASHBOARD_CACHE_TTL_MS),
              value,
            });
            return value;
          })
          .finally(() => this.inflight.delete(key));
        this.inflight.set(key, pending);
      }
      return { ok: true, value: await pending };
    } catch (error) {
      return failure(error);
    }
  }

  private store(key: string, entry: Entry): void {
    const max = this.deps.maxEntries ?? DASHBOARD_CACHE_MAX_ENTRIES;
    const now = this.deps.now().getTime();
    this.cache.delete(key);
    if (this.cache.size >= max) {
      for (const [other, held] of this.cache) if (held.expiresAt <= now) this.cache.delete(other);
      while (this.cache.size >= max) {
        const oldest = this.cache.keys().next();
        if (oldest.done) break;
        this.cache.delete(oldest.value);
      }
    }
    this.cache.set(key, entry);
  }
}
