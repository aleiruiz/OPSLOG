import { createHash } from 'node:crypto';
import { appendLocalAuditAndDelivery } from '../../../audit/src/index.js';
import type { EntityManager } from 'typeorm';

export async function appendMaintenanceAudit(
  manager: EntityManager,
  input: {
    readonly tenantId: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly actorId: string;
    readonly actorKind?: 'user' | 'system';
    readonly action: string;
    readonly occurredAt: string;
    readonly revision: string;
  },
): Promise<void> {
  const eventId = `${input.entityId}.${createHash('sha256').update(`${input.action}|${input.revision}`).digest('hex').slice(0, 24)}`;
  await appendLocalAuditAndDelivery(manager, {
    eventId,
    tenantId: input.tenantId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    occurredAt: input.occurredAt,
    actor: { id: input.actorId, kind: input.actorKind ?? 'user' },
    correlationId: eventId,
    data: { attempts: 1 },
  });
}
