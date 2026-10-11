import {
  MySqlAuditApiStore,
  MySqlAuditRelay,
  MySqlTenantOutboxStore,
} from '../../../../../packages/persistence/audit/src/index.js';

export function isDurableAuditAdapterSet(
  audit: unknown,
  auditRelay: unknown,
  outbox: unknown,
): boolean {
  return (
    audit instanceof MySqlAuditApiStore &&
    auditRelay instanceof MySqlAuditRelay &&
    outbox instanceof MySqlTenantOutboxStore
  );
}
