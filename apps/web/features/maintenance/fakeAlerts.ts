import type { BffMaintenanceAlert, Page } from '@opslog/contracts';
import type { MaintenancePorts, Result } from './ports';

/**
 * In-memory alert listing for tests, stories and the mock API. Mimics the route: newest first,
 * `planId`/`vehicleId` filters, opaque offset cursors and the page size the query asks for.
 */
export function createFakeAlertPort(
  alerts: readonly BffMaintenanceAlert[],
  failing: () => boolean,
): MaintenancePorts['alerts'] {
  return {
    list: async (query): Promise<Result<Page<BffMaintenanceAlert>>> => {
      if (failing())
        return {
          ok: false,
          error: { status: 500, code: 'internal_error', message: 'x', correlationId: 'fake' },
        };
      const matching = alerts
        .filter(
          (alert) =>
            (query?.planId === undefined || alert.planId === query.planId) &&
            (query?.vehicleId === undefined || alert.vehicleId === query.vehicleId),
        )
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
      const offset = query?.cursor ? Number(query.cursor.replace('fake:', '')) : 0;
      return { ok: true, value: page(matching, offset, query?.limit ?? 25) };
    },
  };
}

function page(
  matching: readonly BffMaintenanceAlert[],
  offset: number,
  limit: number,
): Page<BffMaintenanceAlert> {
  const next = offset + limit;
  return {
    items: structuredClone(matching.slice(offset, next)),
    nextCursor: next < matching.length ? `fake:${next}` : null,
    total: matching.length,
    sort: { field: 'occurredAt', direction: 'desc' },
  };
}
