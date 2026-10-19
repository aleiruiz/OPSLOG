import type {
  BffAuditEntityQuery,
  BffAuditPage,
  BffAuditQuery,
  BffAuditReconciliation,
  BffAuditReconciliationQuery,
} from './bff.js';
import type { BffClient, BffResult } from './client.js';

/**
 * Typed audit calls over any `BffClient` (S26 and the «Historial» tab of each record). `list` and
 * `reconciliation` need `view_audit`; `forEntity` needs it and the read permission of the record's module.
 * Restricted fields come back as `state: 'restricted'` without their value.
 */
export interface AuditClient {
  list(query?: BffAuditQuery): Promise<BffResult<BffAuditPage>>;
  forEntity(
    entityType: string,
    entityId: string,
    query?: BffAuditEntityQuery,
  ): Promise<BffResult<BffAuditPage>>;
  reconciliation(query?: BffAuditReconciliationQuery): Promise<BffResult<BffAuditReconciliation>>;
}

export function createAuditClient(client: BffClient): AuditClient {
  return {
    list: (query) => (query ? client.call('audit.list', { query }) : client.call('audit.list')),
    forEntity: (entityType, entityId, query) =>
      query
        ? client.call('audit.entity', { params: { entityType, entityId }, query })
        : client.call('audit.entity', { params: { entityType, entityId } }),
    reconciliation: (query) =>
      query ? client.call('audit.reconciliation', { query }) : client.call('audit.reconciliation'),
  };
}
