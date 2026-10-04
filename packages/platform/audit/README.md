# CORE-AUDIT

This package defines the transaction boundary for tenant audit records and
outbox events. A persistence adapter must implement `AuditOutboxStore` with a
single database transaction for `appendAudit` and `enqueue`; the in-memory
adapter is synthetic test infrastructure only.

The audit contract intentionally accepts scalar metadata only and removes
known secret/PII fields before storage. Domain payloads stay out of the audit
record and outbox payloads are required to be minimal scalar data.

Traceability:

- rollback without publication: `service.test.ts`
- audit without PII: `service.test.ts`
- tenant mismatch rejection: `service.test.ts`
- worker rejection for missing/suspended tenants and idempotent delivery:
  `apps/worker/base/src/dispatcher.test.ts`
- durable reconciliation: `AuditOutboxStore.reconcile`
