import type { BffIncident, BffIncidentsQuery, Page } from '@opslog/contracts';

/** The server's list for the tests: filters, order and cursor of `GET /incidents` over the given cases. */
export function fakeIncidentPage(
  all: readonly BffIncident[],
  query: BffIncidentsQuery | undefined,
  userId: string,
): Page<BffIncident> {
  const statuses = query?.status?.split(',');
  const field = query?.sort ?? 'occurredAt';
  const direction = query?.direction ?? 'desc';
  const key = (item: BffIncident): string => String(item[field] ?? '');
  const day = (item: BffIncident): string => (item.occurredAt ?? '').slice(0, 10);
  const items = all
    .filter((item) => !statuses || statuses.includes(item.status))
    .filter((item) => !query?.severity || item.severity === query.severity)
    .filter((item) => !query?.type || item.type === query.type)
    .filter((item) => !query?.vehicleId || item.vehicle.id === query.vehicleId)
    .filter((item) => !query?.occurredFrom || day(item) >= query.occurredFrom)
    .filter((item) => !query?.occurredTo || (day(item) !== '' && day(item) <= query.occurredTo))
    .filter((item) => query?.responsible !== 'me' || item.responsible?.id === userId)
    .filter((item) => query?.createdBy !== 'me' || item.createdBy.id === userId)
    .sort(
      (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * (direction === 'asc' ? 1 : -1),
    );
  const start = query?.cursor ? Number(query.cursor) : 0;
  const next = start + (query?.limit ?? 25);
  return {
    items: items.slice(start, next),
    nextCursor: next < items.length ? String(next) : null,
    total: items.length,
    sort: { field, direction },
  };
}
