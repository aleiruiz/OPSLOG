import { randomUUID } from 'node:crypto';
import type { Permission } from '../../../../../packages/domain/identity/src/index.js';
import type { PersistedAuditEvent } from '../../../../../packages/platform/audit/src/index.js';
import { failure, success, type PlatformResponse } from './errors.js';
import { ACTOR_PREFIX } from './kernel.js';
import type { PlatformKernel } from './kernel.js';
import type { Emit } from './types.js';

/** Audit trail of the caller's tenant only; there is no way to name another tenant. */
export async function listAudit(
  k: PlatformKernel,
  token: string,
  correlationId: string,
): Promise<PlatformResponse<readonly PersistedAuditEvent[]>> {
  try {
    const context = await k.authorize(token, correlationId, ['view_audit']);
    return success(k.audit.list(context.tenantId));
  } catch (error) {
    return failure(error);
  }
}

/**
 * Runs `work` in an outbox transaction scoped to the caller's tenant. If `work` throws, nothing
 * is published. Tenant, actor and correlation come from the session, not from the event input.
 */
export async function publish<T>(
  k: PlatformKernel,
  token: string,
  correlationId: string,
  work: (emit: Emit) => T,
  permission: Permission = 'create',
): Promise<PlatformResponse<T>> {
  try {
    const context = await k.authorize(token, correlationId, [permission]);
    const result = k.outbox.transaction((tx) =>
      work((event) => {
        tx.enqueue({
          eventId: event.eventId ?? `evt-${randomUUID()}`,
          tenantId: context.tenantId,
          type: event.type,
          payload: event.payload,
          occurredAt: k.now().toISOString(),
          idempotencyKey: event.idempotencyKey ?? randomUUID(),
          correlationId,
          actorRef: { subject: `${ACTOR_PREFIX}${context.actor.subject}`, kind: 'user' },
          requiredPermission: permission,
          entityId: event.entityId,
          schemaVersion: 1,
        });
      }),
    );
    return success(result);
  } catch (error) {
    return failure(error);
  }
}
