import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuditDeliveryEntity,
  AuditLocalEventEntity,
} from '../../../packages/persistence/audit/src/entities.js';
import {
  InMemoryTenantStore,
  MAX_CUSTOM_ROLES_PER_TENANT,
  RoleCatalog,
  RoleDirectory,
  isRoleDirectoryStore,
  type RoleDirectoryStore,
} from '../../../apps/api/composition/src/index.js';
import {
  AUDIT_ENTITIES,
  appendLocalAuditAndDelivery,
  createMySqlAuditRuntime,
} from '../../../packages/persistence/audit/src/index.js';
import {
  IdentityEntity,
  MembershipEntity,
  RoleEntity,
  RolePermissionEntity,
  TypeOrmIdentityStore,
} from '../../../packages/persistence/identity/src/index.js';
import {
  FakeDatabase,
  asDataSource,
} from '../../../packages/persistence/identity/src/test-support/fake-database.js';
import { corr, createWorld, type World } from './world.js';

/**
 * The platform on the persistent identity store with the persistent role directory: custom roles
 * are rows of the same store, membership roles are written through `setRole`, and the tenant
 * boundary and last-administrator rule hold in the fake driver as well as in the directory. The
 * real MySQL behavior is covered by the dedicated integration suites.
 */
let world: World;
afterEach(() => {
  vi.restoreAllMocks();
  world?.dispose();
});

function persistentWorld(options: { roleStore?: RoleDirectoryStore } = {}) {
  const db = new FakeDatabase(AUDIT_ENTITIES);
  Object.defineProperty(db.options, 'database', { value: 'opslog_t_fake_roles' });
  const tenants = new InMemoryTenantStore();
  const source = asDataSource(db);
  const auditRuntime = createMySqlAuditRuntime({
    listTenantIds: () => tenants.all().map((tenant) => tenant.id),
    resolveRuntime: () => source,
    resolveRelay: () => source,
    resolveReader: () => source,
  });
  const identityStore = new TypeOrmIdentityStore(asDataSource(db), {
    appendAudit: (manager, event) =>
      appendLocalAuditAndDelivery(manager, { ...event, data: {} }).then(() => undefined),
  });
  world = createWorld({
    adapters: {
      identityStore,
      tenants,
      audit: auditRuntime.audit,
      auditRelay: auditRuntime.auditRelay,
      ...options,
    },
  });
  return { db, identityStore, tenants };
}

const roleOf = async (store: TypeOrmIdentityStore, tenantId: string, identityId: string) =>
  store.findRole(tenantId, identityId);

describe('role directory wiring', () => {
  it('uses the identity store as the role directory when it implements the port', async () => {
    persistentWorld();
    expect(world.platform.roles.persistent).toBe(true);
    expect(isRoleDirectoryStore(new TypeOrmIdentityStore(asDataSource(new FakeDatabase())))).toBe(
      true,
    );
    expect(isRoleDirectoryStore({ listCustomRoles: () => [] })).toBe(false);
    expect(isRoleDirectoryStore(null)).toBe(false);
  });

  it('keeps everything in memory with the in-memory identity store', async () => {
    world = createWorld();
    expect(world.platform.roles.persistent).toBe(false);
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const copy = await world.platform.copyRole(a.admin.token, corr(), 'viewer', 'Regional');
    expect(copy.ok).toBe(true);
    expect(world.platform.roles.catalog.custom(a.tenantId).map((role) => role.name)).toEqual([
      'Regional',
    ]);
    // Same answers as the persistent directory: unknown ids, taken names and the limit.
    expect((await world.platform.copyRole(a.admin.token, corr(), 'nope', 'X')).error?.code).toBe(
      'not_found',
    );
    expect(
      (await world.platform.copyRole(a.admin.token, corr(), 'viewer', 'regional')).error?.code,
    ).toBe('conflict');
    expect(
      (await world.platform.copyRole(a.admin.token, corr(), 'viewer', 'Auditoría')).error?.code,
    ).toBe('conflict');
    for (let index = 1; index < MAX_CUSTOM_ROLES_PER_TENANT; index += 1)
      expect(
        (await world.platform.copyRole(a.admin.token, corr(), 'viewer', `Rol ${index}`)).ok,
      ).toBe(true);
    expect(
      (await world.platform.copyRole(a.admin.token, corr(), 'viewer', 'Uno más')).error?.code,
    ).toBe('conflict');
  });

  it('accepts an explicit role store and maps its refusals to conflicts', async () => {
    const calls: string[] = [];
    const store: RoleDirectoryStore = {
      listCustomRoles: async () => [],
      findCustomRole: async () => null,
      createCustomRole: async (_tenant, role) => {
        calls.push(role.name);
        return role.name === 'Lleno' ? 'limit_reached' : 'name_taken';
      },
      setRole: async () => true,
    };
    world = createWorld({ adapters: { roleStore: store } });
    expect(world.platform.roles.persistent).toBe(true);
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    for (const name of ['Lleno', 'Repetido', 'Administrador'])
      expect(
        (await world.platform.copyRole(a.admin.token, corr(), 'viewer', name)).error,
      ).toMatchObject({ code: 'conflict', status: 409 });
    // A system label never reaches the store: it is refused before.
    expect(calls).toEqual(['Lleno', 'Repetido']);
  });

  it('the facade keeps the in-memory catalog reachable and sets member roles only with a store', async () => {
    const catalog = new RoleCatalog();
    const memory = new RoleDirectory(undefined, catalog);
    expect(memory.catalog).toBe(catalog);
    expect(await memory.setMemberRole('t', 'i', 'admin')).toBe(true);
    expect(await memory.find('t', 'viewer')).toMatchObject({ permissions: ['view'] });
    expect(await memory.find('t', 'custom-x')).toBeUndefined();
  });
});

describe('custom roles in the persistent store', () => {
  it('persists a role copy with its permissions and shows it in the role list', async () => {
    const { db, identityStore } = persistentWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const copy = await world.platform.copyRole(
      a.admin.token,
      corr(),
      'auditor',
      '  Auditor externo ',
    );
    expect(copy).toMatchObject({
      ok: true,
      value: { name: 'Auditor externo', kind: 'custom', permissions: ['view', 'view_audit'] },
    });
    const id = copy.value?.id as string;
    expect(db.committed(RoleEntity)).toMatchObject([
      { tenantId: a.tenantId, id, name: 'Auditor externo', nameKey: 'auditor externo' },
    ]);
    expect(db.committed(RolePermissionEntity).map((row) => row.permission)).toEqual([
      'view',
      'view_audit',
    ]);
    expect(await identityStore.findCustomRole(a.tenantId, id)).toEqual({
      id,
      name: 'Auditor externo',
      permissions: ['view', 'view_audit'],
    });
    const roles = await world.platform.listRoles(a.admin.token, corr());
    expect(roles.value?.filter((role) => role.kind === 'custom')).toEqual([
      {
        id,
        name: 'Auditor externo',
        kind: 'custom',
        permissions: ['view', 'view_audit'],
        memberCount: 0,
      },
    ]);
    // A role can be copied again: custom roles are valid sources.
    world.advance(1000);
    const again = await world.platform.copyRole(a.admin.token, corr(), id, 'Copia de copia');
    expect(again.value?.permissions).toEqual(['view', 'view_audit']);
    // The roles outlive the platform: another process on the same database reads them.
    const other = new TypeOrmIdentityStore(asDataSource(db));
    expect((await other.listCustomRoles(a.tenantId)).map((role) => role.name)).toEqual([
      'Auditor externo',
      'Copia de copia',
    ]);
  });

  it('keeps names unique per tenant, refuses system names and the limit, and never leaks across tenants', async () => {
    const { db } = persistentWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    const copy = (session: typeof a.admin, source: string, name: string) =>
      world.platform.copyRole(session.token, corr(), source, name);
    const created = await copy(a.admin, 'viewer', 'Regional');
    expect(created.ok).toBe(true);
    for (const name of ['regional', ' REGIONAL ', 'Administrador', 'consulta'])
      expect((await copy(a.admin, 'viewer', name)).error?.code).toBe('conflict');
    expect((await copy(a.admin, 'viewer', '  ')).error?.code).toBe('invalid_input');
    expect((await copy(a.admin, 'viewer', 'x'.repeat(81))).error?.code).toBe('invalid_input');
    expect((await copy(a.admin, 'viewer', 7 as never)).error?.code).toBe('invalid_input');
    expect((await copy(a.admin, 'nada', 'Otro')).error?.code).toBe('not_found');
    expect((await copy(a.admin, 7 as never, 'Otro')).error?.code).toBe('not_found');
    // Tenant B cannot see, copy or collide with A's role; the same name is free there.
    expect((await copy(b.admin, created.value?.id as string, 'Robada')).error?.code).toBe(
      'not_found',
    );
    expect((await copy(b.admin, 'viewer', 'Regional')).ok).toBe(true);
    const listB = await world.platform.listRoles(b.admin.token, corr());
    expect(listB.value?.filter((role) => role.kind === 'custom')).toHaveLength(1);
    expect(db.committed(RoleEntity).map((row) => row.tenantId)).toEqual([a.tenantId, b.tenantId]);
    // The per-tenant limit counts only that tenant's roles.
    for (let index = 1; index < MAX_CUSTOM_ROLES_PER_TENANT; index += 1)
      expect((await copy(a.admin, 'editor', `Rol ${index}`)).ok).toBe(true);
    expect((await copy(a.admin, 'editor', 'Uno más')).error).toMatchObject({
      code: 'conflict',
      status: 409,
    });
    expect((await copy(b.admin, 'editor', 'Uno más')).ok).toBe(true);
  }, 30_000);

  it('serializes concurrent copies with one name: exactly one wins, the others conflict', async () => {
    const { db } = persistentWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const outcomes = await Promise.all(
      [1, 2, 3, 4].map(() => world.platform.copyRole(a.admin.token, corr(), 'viewer', 'Igual')),
    );
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.error?.code === 'conflict')).toHaveLength(3);
    expect(db.committed(RoleEntity)).toHaveLength(1);
    expect(db.deadlocks).toBe(0);
  });

  it('answers a role copy exactly as before for a viewer, a revoked session and a suspended tenant', async () => {
    persistentWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const viewer = await world.member(a.admin, 'viewer', 'subject-viewer-a');
    expect((await world.platform.copyRole(viewer.token, corr(), 'viewer', 'X')).error?.code).toBe(
      'forbidden',
    );
    expect((await world.platform.listRoles(viewer.token, corr())).error?.code).toBe('forbidden');
    await world.platform.suspendTenant(a.tenantId);
    expect((await world.platform.copyRole(a.admin.token, corr(), 'viewer', 'X')).error?.code).toBe(
      'unauthorized',
    );
  });

  it('only ever grants permissions the composition knows, even if the row says more', async () => {
    const { db } = persistentWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    db.seed(RoleEntity, {
      tenantId: a.tenantId,
      id: 'custom-seeded',
      name: 'Sembrado',
      nameKey: 'sembrado',
      createdAt: new Date(0),
    });
    db.seed(RolePermissionEntity, {
      tenantId: a.tenantId,
      roleId: 'custom-seeded',
      permission: 'view',
      position: 0,
    });
    db.seed(RolePermissionEntity, {
      tenantId: a.tenantId,
      roleId: 'custom-seeded',
      permission: 'drop_everything',
      position: 1,
    });
    const roles = await world.platform.listRoles(a.admin.token, corr());
    expect(roles.value?.find((role) => role.id === 'custom-seeded')?.permissions).toEqual(['view']);
    const copy = await world.platform.copyRole(a.admin.token, corr(), 'custom-seeded', 'Derivada');
    expect(copy.value?.permissions).toEqual(['view']);
  });
});

describe('membership roles written through setRole', () => {
  it('the first administrator, invited members and role changes keep the stored role equal to the directory', async () => {
    const { db, identityStore } = persistentWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    expect(await roleOf(identityStore, a.tenantId, a.admin.identityId)).toBe('admin');
    expect(await identityStore.countActiveAdmins(a.tenantId)).toBe(1);

    const invited = await platform.inviteUser(a.admin.token, corr(), 'auditor');
    const pendingId = invited.value?.identityId as string;
    // The pending membership already carries the invited role (no elevated default in between).
    expect(await identityStore.findMembership(a.tenantId, pendingId)).toMatchObject({
      status: 'pending',
    });
    const accepted = await platform.acceptInvitation(
      invited.value?.invitationToken as string,
      await world.principal('subject-auditor'),
    );
    expect(accepted.ok).toBe(true);
    expect(await roleOf(identityStore, a.tenantId, pendingId)).toBe('auditor');
    expect(platform.access.roleOf(a.tenantId, pendingId)).toBe('auditor');
    const auditor = await world.signIn('subject-auditor', a.tenantId);

    // Change the role: the stored role, the directory and the permissions follow, sessions end.
    const versionBefore = (await identityStore.findIdentity(pendingId))?.authorizationVersion ?? 0;
    expect((await platform.changeRole(a.admin.token, corr(), pendingId, 'editor')).ok).toBe(true);
    expect(await roleOf(identityStore, a.tenantId, pendingId)).toBe('editor');
    expect(platform.access.roleOf(a.tenantId, pendingId)).toBe('editor');
    expect((await identityStore.findIdentity(pendingId))?.authorizationVersion).toBe(
      versionBefore + 1,
    );
    const durableEvents = db
      .committed(AuditLocalEventEntity)
      .filter((event) => event.tenantId === a.tenantId);
    expect(durableEvents.map((event) => event.action)).toContain('user.invited');
    expect(durableEvents.map((event) => event.action)).toContain('membership.role_changed');
    expect(
      db.committed(AuditDeliveryEntity).filter((delivery) => delivery.tenantId === a.tenantId),
    ).toHaveLength(durableEvents.length);
    expect((await platform.session(auditor.token, corr())).error?.code).toBe('unauthorized');
    const again = await world.signIn('subject-auditor', a.tenantId);
    expect((await platform.sessionDetails(again.token, corr())).value).toMatchObject({
      roleId: 'editor',
      permissions: ['view', 'create', 'edit'],
    });
    // Changing to the same role is accepted and changes nothing.
    expect((await platform.changeRole(a.admin.token, corr(), pendingId, 'editor')).ok).toBe(true);
    expect(await roleOf(identityStore, a.tenantId, pendingId)).toBe('editor');
  });

  it('rolls back invitation and role mutations when the local audit insert fails', async () => {
    const { db, identityStore } = persistentWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');

    const beforeInvitations = db.committed(AuditLocalEventEntity).length;
    db.failNext('insert', { errno: 1062, code: 'ER_DUP_ENTRY' }, { entity: AuditLocalEventEntity });
    const rejectedInvite = await platform.inviteUser(a.admin.token, corr(), 'viewer');
    expect(rejectedInvite.ok).toBe(false);
    expect(db.committed(AuditLocalEventEntity)).toHaveLength(beforeInvitations);
    expect(db.committed(MembershipEntity)).toHaveLength(1);

    const member = await world.member(a.admin, 'viewer', 'subject-viewer');
    const versionBefore = (await identityStore.findIdentity(member.identityId))
      ?.authorizationVersion;
    db.failNext('insert', { errno: 1062, code: 'ER_DUP_ENTRY' }, { entity: AuditLocalEventEntity });
    const rejectedRole = await platform.changeRole(
      a.admin.token,
      corr(),
      member.identityId,
      'editor',
    );
    expect(rejectedRole.ok).toBe(false);
    expect(await roleOf(identityStore, a.tenantId, member.identityId)).toBe('viewer');
    expect((await identityStore.findIdentity(member.identityId))?.authorizationVersion).toBe(
      versionBefore,
    );
  });

  it('refuses a role change for a member of another tenant and changes nothing there', async () => {
    const { identityStore } = persistentWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    const memberB = await world.member(b.admin, 'viewer', 'subject-viewer-b');
    const result = await world.platform.changeRole(
      a.admin.token,
      corr(),
      memberB.identityId,
      'admin',
    );
    expect(result.error?.code).toBe('not_found');
    expect(await roleOf(identityStore, b.tenantId, memberB.identityId)).toBe('viewer');
  });

  it('refuses to demote or remove the last administrator, in the directory and in the store', async () => {
    const { db, identityStore } = persistentWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const demote = await platform.changeRole(a.admin.token, corr(), a.admin.identityId, 'viewer');
    expect(demote.error).toMatchObject({ code: 'last_admin', status: 409 });
    expect(
      (await platform.removeMember(a.admin.token, corr(), a.admin.identityId)).error?.code,
    ).toBe('last_admin');
    expect(await roleOf(identityStore, a.tenantId, a.admin.identityId)).toBe('admin');

    // Another process demoted the second administrator behind this directory's back: the directory
    // still counts two, but the store (under its tenant lock) knows there is only one.
    const second = await world.member(a.admin, 'admin', 'subject-admin-a2');
    expect(await identityStore.setRole(a.tenantId, second.identityId, 'viewer')).toBe(true);
    expect(platform.access.activeAdmins(a.tenantId)).toHaveLength(2);
    const staleDemote = await platform.changeRole(
      second.token,
      corr(),
      a.admin.identityId,
      'viewer',
    );
    expect(staleDemote.error).toMatchObject({ code: 'unauthorized' });
    const adminDemote = await platform.changeRole(
      a.admin.token,
      corr(),
      a.admin.identityId,
      'editor',
    );
    expect(adminDemote.error).toMatchObject({ code: 'last_admin', status: 409 });
    const staleRemove = await platform.removeMember(a.admin.token, corr(), a.admin.identityId);
    expect(staleRemove.error).toMatchObject({ code: 'last_admin', status: 409 });
    // Nothing moved: directory and store still agree on the administrator.
    expect(platform.access.roleOf(a.tenantId, a.admin.identityId)).toBe('admin');
    expect(await roleOf(identityStore, a.tenantId, a.admin.identityId)).toBe('admin');
    expect(db.committed(MembershipEntity).filter((row) => row.role === 'admin')).toHaveLength(1);
  });

  it('two administrators demoting each other concurrently leave exactly one (serialized by the in-process lock; the cross-process guarantee is proven by the store-level MySQL tests)', async () => {
    const { identityStore, db } = persistentWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const second = await world.member(a.admin, 'admin', 'subject-admin-a2');
    const outcomes = await Promise.all([
      platform.changeRole(a.admin.token, corr(), second.identityId, 'viewer'),
      platform.changeRole(second.token, corr(), a.admin.identityId, 'viewer'),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.find((outcome) => !outcome.ok)?.error?.code).toMatch(/last_admin|unauthorized/);
    expect(await identityStore.countActiveAdmins(a.tenantId)).toBe(1);
    expect(platform.access.activeAdmins(a.tenantId)).toHaveLength(1);
    expect(db.deadlocks).toBe(0);
  });

  it('compensates the stored role when the control-plane projection fails, so nothing diverges', async () => {
    const { identityStore, tenants } = persistentWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const member = await world.member(a.admin, 'viewer', 'subject-viewer-a');
    const project = vi
      .spyOn(tenants, 'projectMembership')
      .mockRejectedValueOnce(new Error('control plane unavailable'));
    const failed = await platform.changeRole(a.admin.token, corr(), member.identityId, 'editor');
    expect(failed.error).toMatchObject({ code: 'internal_error', status: 500 });
    expect(project).toHaveBeenCalledOnce();
    expect(platform.access.roleOf(a.tenantId, member.identityId)).toBe('viewer');
    expect(await roleOf(identityStore, a.tenantId, member.identityId)).toBe('viewer');
    // A retry after the control plane recovers succeeds and both sides move together.
    expect((await platform.changeRole(a.admin.token, corr(), member.identityId, 'editor')).ok).toBe(
      true,
    );
    expect(platform.access.roleOf(a.tenantId, member.identityId)).toBe('editor');
    expect(await roleOf(identityStore, a.tenantId, member.identityId)).toBe('editor');
  });

  it('survives a failed compensation without hiding the original error', async () => {
    const { identityStore, tenants } = persistentWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const member = await world.member(a.admin, 'viewer', 'subject-viewer-a');
    vi.spyOn(tenants, 'projectMembership').mockRejectedValueOnce(new Error('control plane down'));
    const setRole = vi.spyOn(identityStore, 'setRole');
    setRole.mockImplementationOnce((tenant, identity, role) =>
      TypeOrmIdentityStore.prototype.setRole.call(identityStore, tenant, identity, role),
    );
    setRole.mockImplementationOnce(async () => {
      throw new Error('store down');
    });
    const failed = await platform.changeRole(a.admin.token, corr(), member.identityId, 'editor');
    expect(failed.error?.code).toBe('internal_error');
    expect(platform.access.roleOf(a.tenantId, member.identityId)).toBe('viewer');
  });

  it('fails closed when the store has no such membership', async () => {
    const { db } = persistentWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const member = await world.member(a.admin, 'viewer', 'subject-viewer-a');
    // The store lost the row (out-of-band change): the directory must not move on its own.
    const rows = db
      .committed(MembershipEntity)
      .filter((row) => row.identityId !== member.identityId);
    db.clear(MembershipEntity);
    for (const row of rows) db.seed(MembershipEntity, row);
    const result = await platform.changeRole(a.admin.token, corr(), member.identityId, 'editor');
    expect(result.error).toMatchObject({ code: 'conflict', status: 409 });
    expect(platform.access.roleOf(a.tenantId, member.identityId)).toBe('viewer');
  });

  it('a tenant that failed to bootstrap is marked failed and cannot be signed in to', async () => {
    const { identityStore, tenants } = persistentWorld();
    vi.spyOn(tenants, 'projectMembership').mockRejectedValueOnce(new Error('control plane down'));
    const created = await world.platform.bootstrapTenant({
      name: 'Empresa Fallida',
      adminPrincipal: await world.principal('subject-admin-x'),
    });
    expect(created.error?.code).toBe('internal_error');
    const [failed] = tenants.all();
    expect(failed?.status).toBe('failed');
    // The administrator role was stored before the failure; the tenant itself never serves requests.
    expect(await identityStore.countActiveAdmins(failed?.id as string)).toBe(1);
    expect(
      (await world.platform.signIn(await world.principal('subject-admin-x'))).error?.code,
    ).toBe('unauthorized');
  });

  it('keeps identities of two tenants apart: roles are per membership', async () => {
    const { db, identityStore } = persistentWorld();
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const b = await world.tenant('Empresa Beta', 'subject-admin-b');
    expect(await roleOf(identityStore, a.tenantId, b.admin.identityId)).toBeNull();
    expect(await roleOf(identityStore, b.tenantId, a.admin.identityId)).toBeNull();
    expect(db.committed(MembershipEntity).map((row) => [row.tenantId, row.role])).toEqual([
      [a.tenantId, 'admin'],
      [b.tenantId, 'admin'],
    ]);
    expect(db.committed(IdentityEntity)).toHaveLength(2);
  });
});
