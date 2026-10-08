import { expect } from 'vitest';
import type { Platform } from '../../../apps/api/composition/src/index.js';
import type { Slow } from './latency.js';

export interface RaceEnv {
  readonly platform: Platform;
  readonly principal: (subject: string) => Promise<unknown>;
  readonly findMembership: (
    tenantId: string,
    identityId: string,
  ) => Promise<{ status: string } | null>;
  /** Resolves when the named identity-store call has started (see `withLatency`). */
  readonly started: (name: Slow) => Promise<void>;
  readonly flushAudit?: () => Promise<unknown>;
}

export type Order = 'accept-first' | 'revoke-first';

/**
 * An administrator invitation is accepted and revoked at the same time, in the same process, in
 * the requested order (the second operation starts while the first is inside its store call).
 * Whatever the outcome, directory, store, audit trail and last-administrator rule must agree.
 */
export async function raceAcceptAndRevoke(env: RaceEnv, tag: string, order: Order) {
  const { platform } = env;
  const created = await platform.bootstrapTenant({
    name: `Empresa ${tag}`,
    adminPrincipal: (await env.principal(`admin-${tag}`)) as never,
  });
  const tenantId = created.value!.tenantId;
  const adminId = created.value!.adminIdentityId;
  const token = (await platform.signIn((await env.principal(`admin-${tag}`)) as never)).value!
    .token;
  const invited = (await platform.inviteUser(token, `c-${tag}`, 'admin')).value!;
  const invitee = (await env.principal(`invitee-${tag}`)) as never;

  let accept: ReturnType<Platform['acceptInvitation']>;
  let remove: ReturnType<Platform['removeMember']>;
  if (order === 'accept-first') {
    accept = platform.acceptInvitation(invited.invitationToken, invitee);
    await env.started('activateInvitation');
    remove = platform.removeMember(token, `r-${tag}`, invited.identityId);
  } else {
    remove = platform.removeMember(token, `r-${tag}`, invited.identityId);
    await env.started('revokeMembership');
    accept = platform.acceptInvitation(invited.invitationToken, invitee);
  }
  const [accepted, removed] = await Promise.all([accept, remove]);

  // The order decides the outcome: the operation that holds the tenant first wins.
  expect(removed.ok, `${order} remove`).toBe(true);
  expect(accepted.ok, `${order} accept`).toBe(order === 'accept-first');

  // Directory and store agree: never an active directory entry over a revoked row, or the reverse.
  const stored = await env.findMembership(tenantId, invited.identityId);
  const role = platform.access.roleOf(tenantId, invited.identityId);
  expect(stored?.status).toBe('revoked');
  expect(role).toBeNull();
  expect(platform.access.hasPending(invited.identityId, tenantId)).toBe(false);
  expect(platform.access.activeAdmins(tenantId)).toEqual([adminId]);
  const listed = (await platform.listMembers(token, `l-${tag}`)).value!.members;
  expect(listed.find((member) => member.id === invited.identityId)?.status).not.toBe('active');
  expect(listed.find((member) => member.id === invited.identityId)?.status).not.toBe('invited');

  // The audit trail says what really happened.
  await env.flushAudit?.();
  const actions = (await platform.audit.list(tenantId)).map((event) => event.action);
  const count = (action: string) => actions.filter((item) => item === action).length;
  if (order === 'accept-first') {
    expect([
      count('user.joined'),
      count('membership.revoked'),
      count('invitation.revoked'),
    ]).toEqual([1, 1, 0]);
  } else {
    expect([
      count('user.joined'),
      count('membership.revoked'),
      count('invitation.revoked'),
    ]).toEqual([0, 0, 1]);
  }

  // The invitee cannot sign in, and the sole administrator cannot be removed.
  expect((await platform.signIn(invitee)).ok).toBe(false);
  expect((await platform.removeMember(token, `s-${tag}`, adminId)).error?.code).toBe('last_admin');
  expect((await platform.session(token, `x-${tag}`)).ok).toBe(true);
}
