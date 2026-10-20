import type {
  BffAuditEntityQuery,
  BffAuditPage,
  BffAuditQuery,
  BffAuditReconciliation,
  BffAuditReconciliationQuery,
} from '@opslog/contracts';
import type { Result } from '../../app/types';

/**
 * What the audit screens need from the BFF (S26 and the «Historial» tab of each record). Every call is
 * read-only: nothing is repaired from the UI (ADR-0016). Exporting goes through the `audit_log` report
 * (the «Exportar» link of the screen), not through this port.
 */
export interface AuditPort {
  list(query?: BffAuditQuery): Promise<Result<BffAuditPage>>;
  forEntity(
    entityType: string,
    entityId: string,
    query?: BffAuditEntityQuery,
  ): Promise<Result<BffAuditPage>>;
  reconciliation(query?: BffAuditReconciliationQuery): Promise<Result<BffAuditReconciliation>>;
}
