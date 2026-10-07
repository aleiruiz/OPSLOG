import { PlatformError, failure, success, type PlatformResponse } from './errors.js';
import type { PlatformKernel } from './kernel.js';
import type { DraftView } from './types.js';

const DRAFT_SCOPE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
const DRAFT_LIMITS = { keys: 50, keyLength: 64, valueLength: 2000, totalLength: 16_000 } as const;
/** Drafts belong to the signed-in person; no permission beyond a valid session is needed. */
export async function loadDraft(
  k: PlatformKernel,
  token: string,
  correlationId: string,
  scope: string,
): Promise<PlatformResponse<DraftView | null>> {
  try {
    const context = await k.identity.authenticate(token, correlationId);
    if (typeof scope !== 'string' || !DRAFT_SCOPE.test(scope))
      throw new PlatformError('invalid_input');
    return success(k.drafts.load(context.tenantId, context.actor.subject, scope));
  } catch (error) {
    return failure(error);
  }
}

export async function saveDraft(
  k: PlatformKernel,
  token: string,
  correlationId: string,
  scope: string,
  values: unknown,
): Promise<PlatformResponse<DraftView>> {
  try {
    const context = await k.identity.authenticate(token, correlationId);
    if (typeof scope !== 'string' || !DRAFT_SCOPE.test(scope))
      throw new PlatformError('invalid_input');
    if (typeof values !== 'object' || values === null || Array.isArray(values))
      throw new PlatformError('invalid_input');
    const entries = Object.entries(values);
    let total = 0;
    for (const [key, value] of entries) {
      if (
        typeof value !== 'string' ||
        key.length === 0 ||
        key.length > DRAFT_LIMITS.keyLength ||
        value.length > DRAFT_LIMITS.valueLength
      )
        throw new PlatformError('invalid_input');
      total += key.length + value.length;
    }
    if (entries.length > DRAFT_LIMITS.keys || total > DRAFT_LIMITS.totalLength)
      throw new PlatformError('invalid_input');
    const record: DraftView = {
      scope,
      values: Object.freeze(Object.fromEntries(entries) as Record<string, string>),
      savedAt: k.now(),
    };
    if (!k.drafts.save(context.tenantId, context.actor.subject, record))
      throw new PlatformError('conflict');
    return success(record);
  } catch (error) {
    return failure(error);
  }
}

export async function discardDraft(
  k: PlatformKernel,
  token: string,
  correlationId: string,
  scope: string,
): Promise<PlatformResponse<null>> {
  try {
    const context = await k.identity.authenticate(token, correlationId);
    if (typeof scope !== 'string' || !DRAFT_SCOPE.test(scope))
      throw new PlatformError('invalid_input');
    k.drafts.discard(context.tenantId, context.actor.subject, scope);
    return success(null);
  } catch (error) {
    return failure(error);
  }
}
