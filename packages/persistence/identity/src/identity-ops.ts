import {
  AuthError,
  type ExternalIdentity,
  type Identity,
} from '../../../domain/identity/src/index.js';
import { ExternalIdentityEntity, IdentityEntity } from './entities.js';
import { toExternal, toIdentity } from './row-mappers.js';
import type { IdentityStoreCore } from './store-core.js';
import { invalid, isDate, nonBlank } from './store-support.js';

export async function findIdentity(core: IdentityStoreCore, id: string): Promise<Identity | null> {
  if (!nonBlank(id, 64)) return null;
  return core.single('findIdentity', async () => {
    const row = await core.dataSource.getRepository(IdentityEntity).findOneBy({ id });
    return row ? toIdentity(row) : null;
  });
}

export async function findExternal(
  core: IdentityStoreCore,
  provider: string,
  subject: string,
): Promise<ExternalIdentity | null> {
  if (!nonBlank(provider, 200) || !nonBlank(subject, 200)) return null;
  return core.single('findExternal', async () => {
    const row = await core.dataSource
      .getRepository(ExternalIdentityEntity)
      .findOneBy({ provider, subject });
    return row ? toExternal(row) : null;
  });
}

export async function createExternalIdentity(
  core: IdentityStoreCore,
  identity: Identity,
  external: ExternalIdentity,
): Promise<ExternalIdentity> {
  if (
    !nonBlank(identity.id, 64) ||
    !nonBlank(external.id, 64) ||
    !nonBlank(external.provider, 200) ||
    !nonBlank(external.subject, 200) ||
    external.identityId !== identity.id ||
    !isDate(identity.createdAt) ||
    !isDate(external.createdAt)
  )
    return invalid();
  try {
    await core.transaction('createExternalIdentity', async (manager) => {
      await manager.getRepository(IdentityEntity).insert({
        id: identity.id,
        status: identity.status,
        mfa: identity.mfa,
        authorizationVersion: identity.authorizationVersion,
        createdAt: identity.createdAt,
      });
      await manager.getRepository(ExternalIdentityEntity).insert({
        id: external.id,
        provider: external.provider,
        subject: external.subject,
        identityId: external.identityId,
        status: external.status,
        createdAt: external.createdAt,
      });
    });
    return external;
  } catch (error) {
    // A concurrent creator of the same provider+subject won: its link is the answer.
    // (The duplicate rolled back our identity row, so no orphan identity remains.)
    if (!(error instanceof AuthError) || error.code !== 'conflict') throw error;
    const winner = await findExternal(core, external.provider, external.subject);
    if (!winner) throw error;
    return winner;
  }
}
