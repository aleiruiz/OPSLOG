import {
  IncidentError,
  type IncidentActor,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import type { TenantContext } from '../../../../../packages/domain/identity/src/index.js';
import type { IncidentApiDeps, IncidentApiErrorCode, IncidentApiResponse } from './types.js';

export const STATUS: Readonly<Record<IncidentApiErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  invalid_input: 400,
  not_found: 404,
  stale_version: 409,
  invalid_transition: 409,
  rule_violation: 422,
  duplicate: 409,
  idempotency_conflict: 409,
  idempotency_key_required: 400,
  missing_requirements: 422,
  internal_error: 500,
};
const KNOWN = new Set<string>(Object.keys(STATUS));
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Maps any failure to a safe payload: a code, a generic message and the names of bad fields; never a value. */
export function fail(error: unknown): IncidentApiResponse<never> {
  const raw =
    error instanceof IncidentError
      ? error.code
      : typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';
  const code: IncidentApiErrorCode =
    raw === 'expired'
      ? 'unauthorized'
      : KNOWN.has(raw)
        ? (raw as IncidentApiErrorCode)
        : 'internal_error';
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code],
      message: code === 'internal_error' ? 'Request failed' : `Incident request rejected: ${code}`,
      ...(error instanceof IncidentError && error.fieldErrors.length > 0
        ? { fieldErrors: error.fieldErrors }
        : {}),
      ...(error instanceof IncidentError && error.rule ? { rule: error.rule } : {}),
      ...(error instanceof IncidentError && error.missingRequirements.length > 0
        ? { missingRequirements: error.missingRequirements }
        : {}),
    },
  };
}

export type SessionDeps = Pick<IncidentApiDeps, 'authorize' | 'mechanicLinked' | 'deny'>;

/**
 * Runs `work` as the session's member. Tenant, actor, grants and mechanic scope come only from the
 * session. `entityId` is the requested incident, when the request names one (audited when access is
 * refused with 403 or 404).
 */
export async function runSession<T>(
  deps: SessionDeps,
  token: string,
  correlationId: string,
  entityId: string,
  work: (tenantId: string, actor: IncidentActor, context: TenantContext) => Promise<T>,
): Promise<IncidentApiResponse<T>> {
  let denied: (() => Promise<void>) | null = null;
  try {
    const { context, permissions } = await deps.authorize(token, correlationId);
    const tenantId = context.tenantId;
    const actor: IncidentActor = {
      id: `user-${context.actor.subject}`,
      subject: context.actor.subject,
      permissions,
      mechanicLinked: await deps.mechanicLinked(tenantId, context.actor.subject),
    };
    denied = () =>
      deps.deny(
        context,
        'incident.access_denied',
        OPAQUE_ID.test(entityId) ? entityId : 'unknown',
        correlationId,
      );
    return { ok: true, value: await work(tenantId, actor, context) };
  } catch (error) {
    if (
      denied &&
      error instanceof IncidentError &&
      (error.code === 'forbidden' || error.code === 'not_found')
    )
      // Best effort: the refusal is what the caller sees, whether or not the audit lands.
      await denied().catch(() => undefined);
    return fail(error);
  }
}
