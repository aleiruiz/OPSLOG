import {
  AuditQueryService,
  InMemoryAuditReader,
  InMemoryAuditReconciler,
  byNewest,
  isDeniedAction,
  type AuditEventReader,
  type AuditEventRow,
  type AuditReconciler,
  type AuditSnapshot,
} from '../../../../../packages/domain/audit-query/src/index.js';
import {
  InMemoryAuditStore,
  type AuditStore,
  type PersistedAuditEvent,
} from '../../../../../packages/platform/audit/src/index.js';
import {
  MySqlAuditApiStore,
  MySqlAuditRelay,
} from '../../../../../packages/persistence/audit/src/index.js';
import { AuditQueryApi } from '../../../audit-query/src/index.js';
import { ROLE_LABELS } from '../directory.js';
import {
  entityDescribers,
  incidentChanges,
  workOrderChanges,
  type AuditDescriptionSources,
} from './audit-query-sources.js';
import type { PlatformKernel } from './kernel.js';

const toRow = (event: PersistedAuditEvent): AuditEventRow => ({
  eventId: event.eventId,
  action: event.action,
  entityType: event.entityType,
  entityId: event.entityId,
  occurredAt: event.occurredAt,
  actor: event.actor,
  correlationId: event.correlationId,
});

/** The most rows an audit store without a query port can be asked for at once (its own bound). */
const LIST_BOUND = 1000;

/**
 * The reader over whatever audit store the platform runs on: the MySQL store answers filters and pages itself;
 * the in-memory one is read from its snapshot. Any other store is read through its bounded listing.
 */
export function auditReader(audit: AuditStore): AuditEventReader {
  if (audit instanceof MySqlAuditApiStore) return audit;
  if (audit instanceof InMemoryAuditStore)
    return new InMemoryAuditReader((tenantId) => audit.snapshotForTesting(tenantId).map(toRow));
  return {
    query: async (tenantId, filter, page) => {
      const listed = await audit.list(tenantId, {
        from: filter.from,
        to: filter.to,
        limit: LIST_BOUND,
      });
      const rows = listed
        .map(toRow)
        .filter(
          (row) =>
            (filter.actorId === undefined || row.actor.id === filter.actorId) &&
            (filter.entityType === undefined || row.entityType === filter.entityType) &&
            (filter.entityId === undefined || row.entityId === filter.entityId) &&
            (filter.actionPrefix === undefined || row.action.startsWith(filter.actionPrefix)) &&
            (filter.result === undefined ||
              isDeniedAction(row.action) === (filter.result === 'denied')),
        )
        .sort(byNewest);
      const after = page.after;
      const rest = after
        ? rows.filter(
            (row) =>
              byNewest(row, { ...row, occurredAt: after.occurredAt, eventId: after.eventId }) > 0,
          )
        : rows;
      return {
        rows: rest.slice(0, page.limit),
        total: rows.length,
        hasMore: rest.length > page.limit,
      };
    },
  };
}

export function auditReconciler(
  audit: AuditStore,
  relay: { runBatch(max?: number): Promise<number> } | undefined,
): AuditReconciler {
  if (relay instanceof MySqlAuditRelay) return relay;
  const snapshot: AuditSnapshot =
    audit instanceof InMemoryAuditStore
      ? (tenantId) => audit.snapshotForTesting(tenantId).map(toRow)
      : () => {
          // An empty list would read as «nothing pending»: without a relay to compare with, it fails instead.
          throw new Error('audit reconciliation has no relay to compare with');
        };
  return new InMemoryAuditReconciler(snapshot);
}

/** The audit screens' API (FR-171, S26): global and per-record history, and the relay reconciliation (FR-170). */
export function buildAuditQueryApi(
  kernel: PlatformKernel,
  relay: { runBatch(max?: number): Promise<number> } | undefined,
  sources: AuditDescriptionSources,
): AuditQueryApi {
  return new AuditQueryApi({
    authorize: async (token, correlationId) => {
      const context = await kernel.authorize(token, correlationId, ['view_audit']);
      return { context, permissions: await kernel.access.resolvePermissions(context) };
    },
    service: new AuditQueryService({
      reader: auditReader(kernel.audit),
      reconciler: auditReconciler(kernel.audit, relay),
      describers: entityDescribers(sources),
      changeSources: {
        incident: incidentChanges(sources.incidents),
        maintenance_work_order: workOrderChanges(sources.workOrders),
      },
      // The identity contract carries no names: a member shows as their role.
      roleOf: async (tenantId, actorId) => {
        const role = await kernel.access.effectiveRole(tenantId, actorId.replace(/^user-/, ''));
        return role ? ROLE_LABELS[role] : null;
      },
      now: kernel.now,
    }),
  });
}
