import type { ApiError, BffClient, BffDashboard, BffDashboardQuery } from '@opslog/contracts';

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ApiError };

/** What the dashboard of Inicio needs from the BFF (FR-140/141). The server decides which widgets come back. */
export interface DashboardPort {
  get(query?: BffDashboardQuery): Promise<Result<BffDashboard>>;
}

export function createDashboardPort(client: BffClient): DashboardPort {
  return {
    get: (query) =>
      query && Object.keys(query).length > 0
        ? client.call('dashboard.get', { query })
        : client.call('dashboard.get'),
  };
}
