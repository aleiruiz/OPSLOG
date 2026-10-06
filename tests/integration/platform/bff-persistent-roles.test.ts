import { afterEach, describe, expect, it } from 'vitest';
import {
  InMemoryTenantStore,
  type PlatformAdapters,
} from '../../../apps/api/composition/src/index.js';
import { createBffWorld, type BffWorld } from '../../../apps/api/bff/src/test-support.js';
import {
  MembershipEntity,
  RoleEntity,
  RolePermissionEntity,
  TypeOrmIdentityStore,
} from '../../../packages/persistence/identity/src/index.js';
import {
  FakeDatabase,
  asDataSource,
} from '../../../packages/persistence/identity/src/test-support/fake-database.js';

/**
 * The BFF routes over the persistent identity store and role directory: the HTTP behaviour of
 * roles and users does not change, and what the routes write lands in the database.
 */
let world: BffWorld;
afterEach(() => world?.dispose());

function persistentBff() {
  const db = new FakeDatabase();
  const identityStore = new TypeOrmIdentityStore(asDataSource(db));
  const adapters: PlatformAdapters = { identityStore, tenants: new InMemoryTenantStore() };
  world = createBffWorld({ adapters });
  return { db, identityStore };
}

describe('roles over HTTP on the persistent directory', () => {
  it('copies, lists and stores a role per tenant, and answers 404 for another tenant role id', async () => {
    const { db } = persistentBff();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    const adminA = await world.loginAs('subject-admin-a');
    const adminB = await world.loginAs('subject-admin-b');

    const copy = await adminA.post('/api/roles/auditor/copy', {
      json: { name: 'Auditor externo' },
    });
    expect(copy.status).toBe(201);
    expect(copy.json).toMatchObject({
      name: 'Auditor externo',
      kind: 'custom',
      permissions: ['view', 'view_audit'],
      memberCount: 0,
    });
    const listA = (await adminA.get('/api/roles')).json.items as { id: string; kind: string }[];
    expect(listA.filter((role) => role.kind === 'custom').map((role) => role.id)).toEqual([
      copy.json.id,
    ]);
    expect(
      (await adminB.get('/api/roles')).json.items.filter(
        (role: { kind: string }) => role.kind === 'custom',
      ),
    ).toEqual([]);
    expect(db.committed(RoleEntity)).toMatchObject([
      { tenantId: a.tenantId, id: copy.json.id, name: 'Auditor externo' },
    ]);

    // B cannot copy A's role, exactly as for an unknown id, and its own namespace stays free.
    const stolen = await adminB.post(`/api/roles/${copy.json.id}/copy`, {
      json: { name: 'Robada' },
    });
    const unknown = await adminB.post('/api/roles/custom-unknown/copy', {
      json: { name: 'Robada' },
    });
    expect(stolen.status).toBe(404);
    expect({ ...stolen.json, correlationId: '' }).toEqual({ ...unknown.json, correlationId: '' });
    expect(
      (await adminB.post('/api/roles/auditor/copy', { json: { name: 'Auditor externo' } })).status,
    ).toBe(201);
    expect(db.committed(RoleEntity).map((row) => row.tenantId)).toEqual([a.tenantId, b.tenantId]);

    // Repeated and system names are conflicts; nothing is stored for them.
    const before = db.committed(RoleEntity).length;
    for (const name of ['AUDITOR EXTERNO', 'Administrador'])
      expect((await adminA.post('/api/roles/viewer/copy', { json: { name } })).status).toBe(409);
    expect(db.committed(RoleEntity)).toHaveLength(before);
  });

  it('changes nothing in the database for requests without a valid CSRF token', async () => {
    const { db } = persistentBff();
    await world.tenant('Empresa Alfa', 'subject-admin-a');
    const admin = await world.loginAs('subject-admin-a');
    for (const csrf of [null, 'forged'])
      expect(
        (await admin.post('/api/roles/viewer/copy', { json: { name: 'Copia' }, csrf })).status,
      ).toBe(403);
    expect(db.committed(RoleEntity)).toEqual([]);
    expect(db.committed(RolePermissionEntity)).toEqual([]);
  });

  it('keeps the stored role of invited members and refuses to remove the last administrator over HTTP', async () => {
    const { identityStore } = persistentBff();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const adminA = await world.loginAs('subject-admin-a');
    const invited = await adminA.post('/api/users/invitations', { json: { roleId: 'editor' } });
    expect(invited.status).toBe(201);
    const pendingId = invited.json.user.id as string;
    expect(await identityStore.findRole(a.tenantId, pendingId)).toBeNull(); // pending: no active role yet
    expect(await identityStore.findMembership(a.tenantId, pendingId)).toMatchObject({
      status: 'pending',
    });
    const accepted = await world.platform.acceptInvitation(
      invited.json.invitationToken as string,
      await world.principal('subject-editor-a'),
    );
    expect(accepted.ok).toBe(true);
    expect(await identityStore.findRole(a.tenantId, pendingId)).toBe('editor');

    const last = await adminA.post(`/api/users/${a.adminId}/deactivate`, {
      json: { reason: 'Baja' },
    });
    expect(last.status).toBe(409);
    expect(last.json).toMatchObject({ code: 'last_admin' });
    expect(await identityStore.countActiveAdmins(a.tenantId)).toBe(1);
  });

  it('two administrators removing each other over HTTP leave exactly one', async () => {
    const { db, identityStore } = persistentBff();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const second = await world.member('subject-admin-a', 'admin', 'subject-admin-a2');
    const first = await world.loginAs('subject-admin-a');
    const other = await world.loginAs('subject-admin-a2');
    const outcomes = await Promise.all([
      first.post(`/api/users/${second.identityId}/deactivate`, { json: { reason: 'Baja' } }),
      other.post(`/api/users/${a.adminId}/deactivate`, { json: { reason: 'Baja' } }),
    ]);
    expect(outcomes.filter((reply) => reply.status === 200)).toHaveLength(1);
    expect(outcomes.filter((reply) => reply.status !== 200)[0]?.status).toBeGreaterThanOrEqual(401);
    expect(await identityStore.countActiveAdmins(a.tenantId)).toBe(1);
    expect(
      db
        .committed(MembershipEntity)
        .filter((row) => row.status === 'active' && row.role === 'admin'),
    ).toHaveLength(1);
    expect(db.deadlocks).toBe(0);
  });
});
