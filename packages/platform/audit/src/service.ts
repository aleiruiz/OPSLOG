import { safeAuditMetadata } from './redaction.js';
import type { AuditEvent, AuditEventInput, AuditOutboxStore, OutboxEventInput } from './types.js';

export class AuditOutboxService {
  constructor(private readonly store: AuditOutboxStore) {}

  async record(input: AuditEventInput, outbox?: OutboxEventInput): Promise<void> {
    if (!input.tenantId) throw new Error('tenant context required');
    const audit: AuditEvent = {
      ...input,
      schemaVersion: 1,
      metadata: safeAuditMetadata(input.metadata),
    };
    await this.store.transaction(async (tx) => {
      await tx.appendAudit(audit);
      if (outbox) {
        if (outbox.tenantId !== input.tenantId) throw new Error('tenant mismatch');
        await tx.enqueue({ ...outbox, schemaVersion: 1, status: 'pending', attempts: 0 });
      }
    });
  }
}
