import type {
  ApiError,
  BffAuditEntry,
  BffAuditPage,
  BffAuditQuery,
  BffAuditReconciliation,
} from '@opslog/contracts';
import type { Result } from '../../app/types';
import type { AuditPort } from './ports';

const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export function makeEntry(index: number, overrides: Partial<BffAuditEntry> = {}): BffAuditEntry {
  const minute = String(59 - (index % 60)).padStart(2, '0');
  const hour = String(23 - Math.floor(index / 60)).padStart(2, '0');
  return {
    eventId: `evt-${String(index).padStart(4, '0')}`,
    occurredAt: `2026-10-05T${hour}:${minute}:00.000Z`,
    action: 'vehicle.updated',
    actionLabel: 'Vehículo actualizado',
    result: 'success',
    entityType: 'vehicle',
    entityTypeLabel: 'Vehículo',
    entityId: 'veh-001',
    entityLabel: 'ECO-001',
    entityAvailable: true,
    actor: { id: 'usr-1', kind: 'user', label: 'Administración', alias: 'U-7F3A21' },
    correlationId: `corr-${index}`,
    changes: null,
    ...overrides,
  };
}

/** Events a demo company might have: a long run of vehicle edits, a denied attempt and an incident edit with a diff. */
export function demoEntries(): BffAuditEntry[] {
  const entries = Array.from({ length: 60 }, (_, index) => makeEntry(index + 3));
  entries.unshift(
    makeEntry(0, {
      action: 'incident.updated',
      actionLabel: 'Siniestro actualizado',
      entityType: 'incident',
      entityTypeLabel: 'Siniestro',
      entityId: 'inc-001',
      entityLabel: 'SIN-2026-000001',
      changes: [
        { field: 'severity', label: 'Gravedad', state: 'value', before: 'low', after: 'high' },
        { field: 'description', label: 'Descripción', state: 'restricted' },
        { field: 'insurerResult', label: 'Resultado de la aseguradora', state: 'not_recorded' },
        {
          field: 'vehicleOperable',
          label: 'Vehículo operable',
          state: 'value',
          before: true,
          after: false,
        },
      ],
    }),
    makeEntry(1, {
      action: 'incident.access_denied',
      actionLabel: 'Acceso denegado a siniestros',
      result: 'denied',
      entityType: 'incident',
      entityTypeLabel: 'Siniestro',
      entityId: 'inc-001',
      entityLabel: 'SIN-2026-000001',
      actor: { id: 'usr-2', kind: 'user', label: 'Consulta', alias: 'U-91C2B4' },
    }),
    makeEntry(2, {
      action: 'vehicle.deleted',
      actionLabel: 'Vehículo eliminado',
      entityId: 'veh-gone',
      entityLabel: 'Registro no disponible',
      entityAvailable: false,
      actor: { id: 'sys', kind: 'system', label: 'Sistema', alias: 'S-0000' },
    }),
  );
  return entries;
}

export interface FakeAudit extends AuditPort {
  /** Queries received, in order, for assertions. */
  readonly calls: BffAuditQuery[];
  reconciliationResult: Result<BffAuditReconciliation>;
  /** Makes the next call of `operation` answer with this HTTP status. */
  failNext(operation: 'list' | 'forEntity' | 'reconciliation', status: number): void;
}

export const CLEAN_RECONCILIATION: BffAuditReconciliation = {
  from: '2026-09-19T00:00:00.000Z',
  to: '2026-10-19T00:00:00.000Z',
  generatedAt: '2026-10-19T12:00:00.000Z',
  local: 63,
  relayed: 63,
  pendingTotal: 0,
  oldestPendingAgeSeconds: null,
  pending: [],
};

/** An in-memory audit port that filters and pages like the BFF does (keyset by position, newest first). */
export function createFakeAudit(entries: readonly BffAuditEntry[] = demoEntries()): FakeAudit {
  const calls: BffAuditQuery[] = [];
  const failures = new Map<string, number>();
  const failed = <T>(operation: string): Result<T> | null => {
    const status = failures.get(operation);
    if (status === undefined) return null;
    failures.delete(operation);
    return {
      ok: false,
      error: {
        status: status as ApiError['status'],
        code: 'failure',
        message: 'Failure',
        correlationId: 'corr-fake',
      },
    };
  };
  const page = (rows: readonly BffAuditEntry[], query: BffAuditQuery): Result<BffAuditPage> => {
    const limit = query.limit ?? 50;
    const start = query.cursor ? Number(query.cursor) : 0;
    const filtered = rows.filter(
      (row) =>
        (!query.action || row.action.startsWith(query.action)) &&
        (!query.entityType || row.entityType === query.entityType) &&
        (!query.result || row.result === query.result) &&
        (!query.from || row.occurredAt >= query.from) &&
        (!query.to || row.occurredAt < query.to),
    );
    const items = filtered.slice(start, start + limit);
    return ok({
      items,
      total: filtered.length,
      nextCursor: start + limit < filtered.length ? String(start + limit) : null,
      sort: { field: 'occurredAt', direction: 'desc' },
      from: query.from ?? '2026-09-19T00:00:00.000Z',
      to: query.to ?? '2026-10-19T00:00:00.000Z',
    });
  };
  const fake: FakeAudit = {
    calls,
    failNext: (operation, status) => {
      failures.set(operation, status);
    },
    reconciliationResult: ok(CLEAN_RECONCILIATION),
    list: async (query = {}) => {
      calls.push(query);
      return failed<BffAuditPage>('list') ?? page(entries, query);
    },
    forEntity: async (entityType, entityId, query = {}) => {
      calls.push({ ...query, entityType, entityId });
      return (
        failed<BffAuditPage>('forEntity') ??
        page(
          entries.filter((row) => row.entityType === entityType && row.entityId === entityId),
          query,
        )
      );
    },
    reconciliation: async () =>
      failed<BffAuditReconciliation>('reconciliation') ?? fake.reconciliationResult,
  };
  return fake;
}
