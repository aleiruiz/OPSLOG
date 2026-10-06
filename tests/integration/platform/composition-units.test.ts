import { describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  InMemoryIdentityStore,
  type Session,
} from '../../../packages/domain/identity/src/index.js';
import { corr, createWorld } from './world.js';
import {
  AccessDirectory,
  InMemoryTenantStore,
  TenantAwareScanQueue,
  createWorkerRuntime,
} from '../../../apps/api/composition/src/index.js';
import type { TenantId, SubjectId } from '../../../packages/domain/tenants/src/index.js';
import type { ScanJob, ScanQueue } from '../../../packages/platform/files/src/index.js';

const tid = (value: string): TenantId => value as TenantId;
const sid = (value: string): SubjectId => value as SubjectId;

describe('AccessDirectory membership edges', () => {
  it('refuses to change or revoke the role of someone who is not an active member', () => {
    const directory = new AccessDirectory(() => true);
    expect(directory.setRole('t1', 'ghost', 'admin')).toBe(false);
    expect(directory.revoke('t1', 'ghost')).toBe(false);
    directory.grant('t1', 'ana', 'viewer');
    expect(directory.revoke('t1', 'ana')).toBe(true);
    expect(directory.revoke('t1', 'ana')).toBe(false);
    expect(directory.setRole('t1', 'ana', 'editor')).toBe(false);
    expect(directory.roleOf('t1', 'ana')).toBeNull();
  });

  it('activates only the invitation recorded for that tenant and identity', () => {
    const directory = new AccessDirectory(() => true);
    directory.expectInvitation('bea', 't1', 'editor');
    expect(directory.activate('bea', 't2')).toBe(false);
    expect(directory.activate('nobody', 't1')).toBe(false);
    expect(directory.activate('bea', 't1')).toBe(true);
    expect(directory.activate('bea', 't1')).toBe(false);
    expect(directory.roleOf('t1', 'bea')).toBe('editor');
  });
});

describe('InMemoryTenantStore control-plane rules', () => {
  it('rejects blank or oversized tenant names', () => {
    const store = new InMemoryTenantStore();
    expect(() => store.provisionVerified('   ')).toThrow('tenant name is required');
    expect(() => store.provisionVerified('x'.repeat(161))).toThrow('tenant name is required');
    expect(store.provisionVerified(` ${'x'.repeat(160)} `).name).toHaveLength(160);
  });

  it('keeps membership projections monotonic and validates versions', async () => {
    const store = new InMemoryTenantStore();
    const tenant = tid('t-1');
    const subject = sid('s-1');
    await expect(store.projectMembership(tenant, subject, 0, 'active')).rejects.toThrow(
      'membership version must be positive',
    );
    await expect(store.projectMembership(tenant, subject, 1.5, 'active')).rejects.toThrow(
      'membership version must be positive',
    );
    const first = await store.projectMembership(tenant, subject, 2, 'active');
    expect(await store.projectMembership(tenant, subject, 2, 'revoked')).toBe(first);
    expect(await store.projectMembership(tenant, subject, 1, 'revoked')).toBe(first);
    const next = await store.projectMembership(tenant, subject, 3, 'revoked');
    expect(next.status).toBe('revoked');
    expect(await store.getMembership(tenant, subject)).toBe(next);
  });

  it('rejects unknown tenants and toggles the status of provisioned ones', async () => {
    const store = new InMemoryTenantStore();
    await expect(store.setTenantStatus(tid('missing'), 'suspended')).rejects.toThrow(
      'unknown tenant',
    );
    const tenant = store.provisionVerified('Empresa Alfa');
    expect(await store.getJob()).toBeUndefined();
    expect(store.status('missing')).toBe('missing');
    await store.setTenantStatus(tenant.id, 'suspended');
    expect(store.status(tenant.id)).toBe('suspended');
    await store.setTenantStatus(tenant.id, 'active');
    expect(store.status(tenant.id)).toBe('active');
    expect(store.all()).toHaveLength(1);
  });
});

describe('TenantAwareScanQueue', () => {
  const job = (tenantId: string, fileId: string): ScanJob =>
    ({ tenantId, fileId, attempts: 1 }) as unknown as ScanJob;

  it('rejects non-positive or fractional hold times', () => {
    const inner = {} as ScanQueue;
    const tenants = new InMemoryTenantStore();
    expect(() => new TenantAwareScanQueue(inner, tenants, 0)).toThrow('holdMs');
    expect(() => new TenantAwareScanQueue(inner, tenants, 1.5)).toThrow('holdMs');
  });

  it('delegates enqueue, complete and defer, and stops when a deferred job repeats', async () => {
    const calls: string[] = [];
    const repeating = job('gone', 'f1');
    const inner: ScanQueue = {
      enqueue: async (t, f) => void calls.push(`enqueue:${t}:${f}`),
      complete: async (t, f) => void calls.push(`complete:${t}:${f}`),
      defer: async (t, f, at) => void calls.push(`defer:${t}:${f}:${at}`),
      claimDue: async () => [repeating, repeating],
    };
    const queue = new TenantAwareScanQueue(inner, new InMemoryTenantStore(), 1_000);
    await queue.enqueue('a', 'b', 1);
    await queue.complete('a', 'b');
    await queue.defer('a', 'b', 5);
    expect(await queue.claimDue(10, 100, 5)).toEqual([]);
    expect(queue.heldBack).toBe(2);
    expect(calls).toEqual([
      'enqueue:a:b',
      'complete:a:b',
      'defer:a:b:5',
      'defer:gone:f1:1010',
      'defer:gone:f1:1010',
    ]);
  });
});

describe('createWorkerRuntime defaults', () => {
  it('builds a runtime with default worker id and delegates scans to the pipeline', async () => {
    const processScans = vi.fn(async () => ({ processed: 0 }));
    const runtime = createWorkerRuntime({
      outbox: { claimDue: async () => [] } as never,
      tenants: new InMemoryTenantStore(),
      audit: {} as never,
      pipeline: { processScans } as never,
      clock: () => 0,
    });
    await runtime.runScans();
    expect(processScans).toHaveBeenCalledOnce();
    expect(runtime.worker).toBeDefined();
  });
});

class SpyIdentityStore extends InMemoryIdentityStore {
  public readonly saved: Session[] = [];
  public readonly revoked: string[] = [];
  public override async saveSession(session: Session): Promise<void> {
    this.saved.push(session);
    return super.saveSession(session);
  }
  public override async revokeSession(id: string, revokedAt: Date): Promise<boolean> {
    this.revoked.push(id);
    return super.revokeSession(id, revokedAt);
  }
}

describe('sign-in and sign-out against the control-plane mirror', () => {
  it('revokes the identity session created by a sign-in whose mirrored membership is not active', async () => {
    const identityStore = new SpyIdentityStore();
    const world = createWorld({ adapters: { identityStore } });
    try {
      const { platform } = world;
      const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
      const before = identityStore.saved.length;
      await world.tenants.projectMembership(
        tid(a.tenantId),
        sid(a.admin.identityId),
        1_000,
        'revoked',
      );
      const login = await platform.signIn(await world.principal('subject-admin-a'));
      expect(login.ok).toBe(false);
      expect(login.error?.code).toBe('unauthorized');
      const created = identityStore.saved.slice(before);
      expect(created).toHaveLength(1);
      const [session] = created;
      expect(identityStore.revoked).toContain(session?.id);
      expect(await identityStore.findSession(session?.tokenHash ?? '')).toMatchObject({
        revokedAt: expect.any(Date),
      });
    } finally {
      world.dispose();
    }
  });

  it('signs out twice without failing and leaves the session unusable', async () => {
    const world = createWorld();
    try {
      const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
      expect((await world.platform.signOut(a.admin.token)).ok).toBe(true);
      expect((await world.platform.signOut(a.admin.token)).ok).toBe(true);
      expect((await world.platform.session(a.admin.token, corr())).ok).toBe(false);
    } finally {
      world.dispose();
    }
  });

  it('maps an expired auth error to unauthorized', async () => {
    const world = createWorld();
    try {
      const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
      const expiring = world.platform.auth;
      vi.spyOn(expiring, 'login').mockRejectedValueOnce(new AuthError('expired'));
      const login = await world.platform.signIn(await world.principal('subject-admin-a'));
      expect(login.error?.code).toBe('unauthorized');
      expect((await world.platform.session(a.admin.token, corr())).ok).toBe(true);
    } finally {
      world.dispose();
    }
  });
});
