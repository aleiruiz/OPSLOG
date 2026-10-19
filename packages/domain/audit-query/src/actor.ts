import { createHash } from 'node:crypto';
import type { AuditActorKind } from './types.js';

/** Stable pseudonym of an actor inside one company: the same person is the same alias on every screen. */
export function actorAlias(tenantId: string, actorId: string): string {
  const digest = createHash('sha256').update(`${tenantId}\u0000${actorId}`).digest('hex');
  return `U-${digest.slice(0, 6).toUpperCase()}`;
}

/** Person-less actors read by kind; people read by role (the identity contract carries no names). */
export function actorLabel(kind: AuditActorKind, role: string | null): string {
  if (kind === 'system') return 'Sistema';
  if (kind === 'api_key') return 'Integración';
  return role ?? 'Usuario de la empresa';
}
