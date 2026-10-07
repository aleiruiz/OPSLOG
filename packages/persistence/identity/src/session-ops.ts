import { IsNull, LessThan, MoreThan } from 'typeorm';
import {
  AuthError,
  type RecoveryRequest,
  type Session,
} from '../../../domain/identity/src/index.js';
import { IdentityEntity, InvitationEntity, RecoveryEntity, SessionEntity } from './entities.js';
import { isMissingParent } from './errors.js';
import { toRecovery, toSession } from './row-mappers.js';
import type { IdentityStoreCore } from './store-core.js';
import { HASH_PATTERN, invalid, isDate, lock, nonBlank } from './store-support.js';

export async function findRecovery(
  core: IdentityStoreCore,
  tokenHash: string,
): Promise<RecoveryRequest | null> {
  if (!HASH_PATTERN.test(tokenHash)) return null;
  return core.single('findRecovery', async () => {
    const row = await core.dataSource.getRepository(RecoveryEntity).findOneBy({ tokenHash });
    return row ? toRecovery(row) : null;
  });
}

export async function saveRecovery(
  core: IdentityStoreCore,
  request: RecoveryRequest,
): Promise<void> {
  if (
    !nonBlank(request.id, 64) ||
    !nonBlank(request.identityId, 64) ||
    !HASH_PATTERN.test(request.tokenHash) ||
    !isDate(request.issuedAt) ||
    !isDate(request.expiresAt)
  )
    return invalid();
  await core.transaction('saveRecovery', async (manager) => {
    // The identity row lock serializes concurrent requests of one identity.
    const identity = await manager
      .getRepository(IdentityEntity)
      .findOne({ where: { id: request.identityId }, lock });
    if (!identity) throw new AuthError('not_found');
    const recoveries = manager.getRepository(RecoveryEntity);
    await recoveries.update(
      { identityId: request.identityId, usedAt: IsNull(), supersededAt: IsNull() },
      { supersededAt: request.issuedAt },
    );
    await recoveries.insert({
      id: request.id,
      identityId: request.identityId,
      tokenHash: request.tokenHash,
      issuedAt: request.issuedAt,
      expiresAt: request.expiresAt,
      usedAt: request.usedAt,
      supersededAt: request.supersededAt ?? null,
    });
  });
}

export async function consumeRecovery(
  core: IdentityStoreCore,
  id: string,
  usedAt: Date,
): Promise<boolean> {
  if (!nonBlank(id, 64) || !isDate(usedAt)) return false;
  return core.transaction('consumeRecovery', async (manager) => {
    const recoveries = manager.getRepository(RecoveryEntity);
    const request = await recoveries.findOneBy({ id });
    if (!request) return false;
    const identities = manager.getRepository(IdentityEntity);
    await identities.findOne({ where: { id: request.identityId }, lock });
    const consumed = await recoveries.update(
      { id, usedAt: IsNull(), supersededAt: IsNull(), expiresAt: MoreThan(usedAt) },
      { usedAt },
    );
    if (consumed.affected !== 1) return false;
    await identities.increment({ id: request.identityId }, 'authorizationVersion', 1);
    return true;
  });
}

// ---- sessions -----------------------------------------------------------------------------

export async function saveSession(core: IdentityStoreCore, session: Session): Promise<void> {
  if (
    !nonBlank(session.id, 64) ||
    !nonBlank(session.identityId, 64) ||
    !nonBlank(session.tenantId, 64) ||
    !HASH_PATTERN.test(session.tokenHash) ||
    !isDate(session.createdAt) ||
    !isDate(session.lastSeenAt) ||
    !isDate(session.expiresAt) ||
    !Number.isSafeInteger(session.authorizationVersion) ||
    session.authorizationVersion < 1
  )
    return invalid();
  await core.single('saveSession', async () => {
    try {
      await core.dataSource.getRepository(SessionEntity).insert({
        id: session.id,
        identityId: session.identityId,
        tenantId: session.tenantId,
        tokenHash: session.tokenHash,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        revokedAt: session.revokedAt,
        authorizationVersion: session.authorizationVersion,
      });
    } catch (error) {
      // A session needs a membership row of its own tenant (composite foreign key).
      if (isMissingParent(error)) throw new AuthError('unauthorized');
      throw error;
    }
  });
}

export async function findSession(
  core: IdentityStoreCore,
  tokenHash: string,
): Promise<Session | null> {
  if (!HASH_PATTERN.test(tokenHash)) return null;
  return core.single('findSession', async () => {
    const row = await core.dataSource.getRepository(SessionEntity).findOneBy({ tokenHash });
    return row ? toSession(row) : null;
  });
}

export async function revokeSession(
  core: IdentityStoreCore,
  id: string,
  revokedAt: Date,
): Promise<boolean> {
  if (!nonBlank(id, 64) || !isDate(revokedAt)) return false;
  return core.single('revokeSession', async () => {
    const result = await core.dataSource
      .getRepository(SessionEntity)
      .update({ id, revokedAt: IsNull() }, { revokedAt });
    return result.affected === 1;
  });
}

// ---- retention ----------------------------------------------------------------------------

/** Deletes sessions, invitations and recovery requests that expired before `before`. */
export async function purgeExpired(
  core: IdentityStoreCore,
  before: Date,
): Promise<{ sessions: number; invitations: number; recoveries: number }> {
  if (!isDate(before)) return invalid();
  return core.transaction('purgeExpired', async (manager) => {
    const criteria = { expiresAt: LessThan(before) };
    const sessions = await manager.getRepository(SessionEntity).delete(criteria);
    const invitations = await manager.getRepository(InvitationEntity).delete(criteria);
    const recoveries = await manager.getRepository(RecoveryEntity).delete(criteria);
    return {
      sessions: sessions.affected ?? 0,
      invitations: invitations.affected ?? 0,
      recoveries: recoveries.affected ?? 0,
    };
  });
}
