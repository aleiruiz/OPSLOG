import { afterEach, describe, expect, it } from 'vitest';
import { corr, createWorld, type World } from './world.js';
import { AccessDirectory, sessionIdOf } from '../../../apps/api/composition/src/index.js';
import { AuthError } from '../../../packages/domain/identity/src/index.js';
import type { SubjectId, TenantId } from '../../../packages/domain/tenants/src/index.js';

let world: World;
afterEach(() => world.dispose());

/** Registers a handler that records what ran, then lets `editor` enqueue one job. */
async function pendingJob(w: World, editorToken: string, handled: string[]) {
  w.platform.runtime.worker.register('demo.created', (_payload, event) => {
    handled.push(event.eventId);
  });
  const published = await w.platform.publish(editorToken, corr(), (emit) =>
    emit({ eventId: 'evt-pending', type: 'demo.created', entityId: 'obj-1', payload: {} }),
  );
  expect(published.ok).toBe(true);
}

describe('isolation matrix: cambio de permisos con trabajo pendiente', () => {
  it('runs a pending job when the actor keeps the permission (control)', async () => {
    world = createWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const editor = await world.member(a.admin, 'editor', 'subject-editor-a');
    const handled: string[] = [];
    await pendingJob(world, editor.token, handled);
    // A role change that still grants `create` does not stop the job.
    expect(
      (await world.platform.changeRole(a.admin.token, corr(), editor.identityId, 'admin')).ok,
    ).toBe(true);
    await world.platform.runtime.drainOutbox();
    expect(handled).toEqual(['evt-pending']);
  });

  it('refuses a pending job when the actor was demoted below the publish permission', async () => {
    world = createWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const editor = await world.member(a.admin, 'editor', 'subject-editor-a');
    const handled: string[] = [];
    await pendingJob(world, editor.token, handled);
    expect(
      (await world.platform.changeRole(a.admin.token, corr(), editor.identityId, 'viewer')).ok,
    ).toBe(true);
    await world.platform.runtime.drainOutbox();
    expect(handled).toEqual([]);
    expect(world.outbox.get(a.tenantId, 'evt-pending')?.status).toBe('dead_letter');
    expect(world.platform.runtime.worker.metrics.rejectedActors).toBe(1);
    expect(world.platform.runtime.worker.dlq.receive()?.body).toEqual({
      eventId: 'evt-pending',
      tenantId: a.tenantId,
      reason: 'actor not permitted',
    });
    // No delivery audit either: nothing happened.
    expect(world.audit.snapshotForTesting(a.tenantId).map((e) => e.action)).not.toContain(
      'outbox.delivered',
    );
  });

  it('refuses a pending job when the actor membership was revoked', async () => {
    world = createWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const editor = await world.member(a.admin, 'editor', 'subject-editor-a');
    const handled: string[] = [];
    await pendingJob(world, editor.token, handled);
    expect((await world.platform.removeMember(a.admin.token, corr(), editor.identityId)).ok).toBe(
      true,
    );
    await world.platform.runtime.drainOutbox();
    expect(handled).toEqual([]);
    expect(world.outbox.get(a.tenantId, 'evt-pending')?.status).toBe('dead_letter');
  });

  it('checks the permission the publisher needed, not just membership', async () => {
    world = createWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const handled: string[] = [];
    world.platform.runtime.worker.register('demo.created', (_p, event) => {
      handled.push(event.eventId);
    });
    await world.platform.publish(
      a.admin.token,
      corr(),
      (emit) =>
        emit({ eventId: 'evt-cfg', type: 'demo.created', entityId: 'obj-cfg', payload: {} }),
      'manage_config',
    );
    // Admin -> editor keeps an active membership but loses `manage_config`.
    const second = await world.member(a.admin, 'admin', 'subject-admin-b');
    expect(
      (await world.platform.changeRole(second.token, corr(), a.admin.identityId, 'editor')).ok,
    ).toBe(true);
    await world.platform.runtime.drainOutbox();
    expect(handled).toEqual([]);
    expect(world.outbox.get(a.tenantId, 'evt-cfg')?.status).toBe('dead_letter');
  });

  it('does not let the same identity in another tenant, with a different role, affect the job', async () => {
    world = createWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    // One identity: editor (may publish) in A and viewer (may not) in B. Sign-in keeps an identity
    // in a single tenant, so the second membership is seeded in the role directory the worker reads.
    const editorA = await world.member(a.admin, 'editor', 'subject-shared');
    world.platform.access.grant(b.tenantId, editorA.identityId, 'viewer');
    expect(world.platform.access.roleOf(a.tenantId, editorA.identityId)).toBe('editor');
    expect(world.platform.access.roleOf(b.tenantId, editorA.identityId)).toBe('viewer');
    const handled: string[] = [];
    await pendingJob(world, editorA.token, handled);
    // Revoking that identity in B must not stop A's job, and a check that read B's viewer role
    // instead of A's editor role would have refused it.
    expect(world.platform.access.revoke(b.tenantId, editorA.identityId)).toBe(true);
    await world.platform.runtime.drainOutbox();
    expect(handled).toEqual(['evt-pending']);
    expect(world.outbox.get(a.tenantId, 'evt-pending')?.status).toBe('delivered');
  });

  it('refuses an actor reference that lacks the platform prefix even if it embeds a valid identity id', async () => {
    world = createWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const handled: string[] = [];
    world.platform.runtime.worker.register('demo.created', (_p, event) => {
      handled.push(event.eventId);
    });
    world.outbox.transaction((tx) =>
      tx.enqueue({
        eventId: 'evt-prefix',
        tenantId: a.tenantId,
        type: 'demo.created',
        payload: {},
        occurredAt: new Date().toISOString(),
        idempotencyKey: 'prefix',
        // Same length as `user-`: without the prefix guard, slicing it off would yield a valid id.
        actorRef: { subject: `xuser${a.admin.identityId}`, kind: 'user' },
      }),
    );
    await world.platform.runtime.drainOutbox();
    expect(handled).toEqual([]);
    expect(world.outbox.get(a.tenantId, 'evt-prefix')?.status).toBe('dead_letter');
  });

  it('refuses an event whose actor reference is not a platform user reference', async () => {
    world = createWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const handled: string[] = [];
    world.platform.runtime.worker.register('demo.created', (_p, event) => {
      handled.push(event.eventId);
    });
    world.outbox.transaction((tx) =>
      tx.enqueue({
        eventId: 'evt-odd',
        tenantId: a.tenantId,
        type: 'demo.created',
        payload: {},
        occurredAt: new Date().toISOString(),
        idempotencyKey: 'odd',
        actorRef: { subject: a.admin.identityId, kind: 'user' },
      }),
    );
    await world.platform.runtime.drainOutbox();
    expect(handled).toEqual([]);
    expect(world.outbox.get(a.tenantId, 'evt-odd')?.status).toBe('dead_letter');
  });

  it('keeps a job without a recorded permission alive while the membership is active', async () => {
    world = createWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const handled: string[] = [];
    world.platform.runtime.worker.register('demo.created', (_p, event) => {
      handled.push(event.eventId);
    });
    world.outbox.transaction((tx) =>
      tx.enqueue({
        eventId: 'evt-nop',
        tenantId: a.tenantId,
        type: 'demo.created',
        payload: {},
        occurredAt: new Date().toISOString(),
        idempotencyKey: 'nop',
        actorRef: { subject: `user-${a.admin.identityId}`, kind: 'user' },
      }),
    );
    await world.platform.runtime.drainOutbox();
    expect(handled).toEqual(['evt-nop']);
  });
});

describe('tenant checks that the happy path never exercises', () => {
  it('rejects a control-plane session mirror of the same subject in another tenant (TenantGate)', async () => {
    world = createWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    expect((await world.platform.session(a.admin.token, corr())).ok).toBe(true);
    const mirrored = (await world.tenants.getSession(sessionIdOf(a.admin.token)))!;
    // The same subject also holds an active membership in tenant B, and the mirror points
    // there: valid in itself (active tenant and membership, current version), but the identity
    // session still says tenant A. Only the tenant comparison can catch this.
    await world.tenants.projectMembership(
      b.tenantId as TenantId,
      a.admin.identityId as SubjectId,
      1,
      'active',
    );
    await world.tenants.saveSession({
      ...mirrored,
      tenantId: b.tenantId as TenantId,
      authorizationVersion: 1,
    });
    const result = await world.platform.session(a.admin.token, corr());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('unauthorized');
  });

  it('rejects a mirror of the same tenant that resolves to a different member (TenantGate subject)', async () => {
    world = createWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const editor = await world.member(a.admin, 'editor', 'subject-editor-a');
    const mirrored = (await world.tenants.getSession(sessionIdOf(a.admin.token)))!;
    const editorMembership = (await world.tenants.getMembership(
      a.tenantId as TenantId,
      editor.identityId as SubjectId,
    ))!;
    await world.tenants.saveSession({
      ...mirrored,
      subjectId: editorMembership.subjectId,
      authorizationVersion: editorMembership.version,
    });
    expect((await world.platform.session(a.admin.token, corr())).error?.code).toBe('unauthorized');
  });

  it('drops the pending directory entry even when the store already lost the membership', async () => {
    world = createWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const invited = (await world.platform.inviteUser(a.admin.token, corr(), 'viewer')).value!;
    // Another process revoked the pending membership first: the store answers not_found.
    await world.platform.identity.revokeMembership(a.tenantId, invited.identityId);
    const removed = await world.platform.removeMember(a.admin.token, corr(), invited.identityId);
    expect(removed.ok).toBe(true);
    expect(world.platform.access.hasPending(invited.identityId, a.tenantId)).toBe(false);
    const members = (await world.platform.listMembers(a.admin.token, corr())).value!.members;
    expect(members.some((m) => m.id === invited.identityId)).toBe(false);
  });

  it('still surfaces a store failure other than not_found when revoking a pending invitation', async () => {
    world = createWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const invited = (await world.platform.inviteUser(a.admin.token, corr(), 'viewer')).value!;
    const identity = world.platform.identity as unknown as {
      revokeMembership: (t: string, i: string) => Promise<void>;
    };
    const original = identity.revokeMembership;
    identity.revokeMembership = async () => {
      throw new AuthError('conflict');
    };
    const removed = await world.platform.removeMember(a.admin.token, corr(), invited.identityId);
    identity.revokeMembership = original;
    expect(removed.ok).toBe(false);
    expect(removed.error?.code).toBe('conflict');
    expect(world.platform.access.hasPending(invited.identityId, a.tenantId)).toBe(true);
  });
});

describe('AccessDirectory pending invitations are tenant scoped', () => {
  it('revokePending, hasPending and membersOf ignore an invitation of another tenant', () => {
    const directory = new AccessDirectory(() => true);
    directory.expectInvitation('bea', 't1', 'editor');
    expect(directory.hasPending('bea', 't2')).toBe(false);
    expect(directory.hasPending('bea', 't1')).toBe(true);
    expect(directory.revokePending('bea', 't2')).toBe(false);
    expect(directory.hasPending('bea', 't1')).toBe(true);
    expect(directory.membersOf('t2')).toEqual([]);
    expect(directory.membersOf('t1')).toEqual([
      { identityId: 'bea', role: 'editor', status: 'pending' },
    ]);
    expect(directory.revokePending('bea', 't1')).toBe(true);
    expect(directory.revokePending('bea', 't1')).toBe(false);
    expect(directory.membersOf('t1')).toEqual([]);
  });
});
