import { createFakeAudit } from '../features/audit/fakePorts';
import type { Guarded } from './mockApiTypes';
import type { ApiPorts } from './types';

/** Audit port of the demo API: needs `view_audit`; the entity route also needs `view` (the demo records are fleet records). */
export function createAuditPorts(guarded: Guarded): Pick<ApiPorts, 'audit'> {
  const store = createFakeAudit();
  return {
    audit: {
      list: (query) => guarded('listAudit', 'view_audit', () => store.list(query)),
      forEntity: (entityType, entityId, query) =>
        guarded('auditEntity', ['view_audit', 'view'], () =>
          store.forEntity(entityType, entityId, query),
        ),
      reconciliation: (query) =>
        guarded('auditReconciliation', 'view_audit', () => store.reconciliation(query)),
    },
  };
}
