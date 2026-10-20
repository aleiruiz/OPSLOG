import { afterEach, describe, expect, it } from 'vitest';
import { corr, createWorld, jpeg, type World } from './world.js';

let world: World;
afterEach(() => world.dispose());

/** Two companies whose files get the same local id, each with an administrator and an auditor. */
async function twoCompanies(w: World) {
  const a = await w.tenant('Empresa Alfa', 'subject-admin-a');
  const b = await w.tenant('Empresa Beta', 'subject-admin-b');
  const auditorA = await w.member(a.admin, 'auditor', 'subject-auditor-a');
  const auditorB = await w.member(b.admin, 'auditor', 'subject-auditor-b');
  const editorA = await w.member(a.admin, 'editor', 'subject-editor-a');
  return { a, b, auditorA, auditorB, editorA };
}

describe('audit query across two companies with equal local ids', () => {
  it('answers each company only its own rows, even when asked for the other one id', async () => {
    world = createWorld({ pipeline: { newId: () => 'shared-local-id' } });
    const { platform } = world;
    const { a, b, auditorA, auditorB } = await twoCompanies(world);
    await world.releasedFile(a.admin, 'alfa.jpg', jpeg('alfa'));
    await world.releasedFile(b.admin, 'beta.jpg', jpeg('beta'));
    world.advance(1_000);

    const forA = await platform.auditQuery.list(auditorA.token, corr(), {
      entityType: 'file',
      entityId: 'shared-local-id',
    });
    const forB = await platform.auditQuery.list(auditorB.token, corr(), {
      entityType: 'file',
      entityId: 'shared-local-id',
    });
    expect(forA.ok && forB.ok).toBe(true);
    expect(forA.value?.tenantId).toBe(a.tenantId);
    expect(forB.value?.tenantId).toBe(b.tenantId);
    const own = (tenantId: string) =>
      world.audit
        .snapshotForTesting(tenantId)
        .filter((event) => event.entityType === 'file' && event.entityId === 'shared-local-id')
        .map((event) => event.eventId)
        .sort();
    expect(forA.value?.items.map((item) => item.eventId).sort()).toEqual(own(a.tenantId));
    expect(forB.value?.items.map((item) => item.eventId).sort()).toEqual(own(b.tenantId));
    expect(forA.value?.total).toBe(own(a.tenantId).length);
    expect(own(a.tenantId).length).toBeGreaterThan(0);
    // What B did to its file is not in A's answer, whatever the equal ids suggest.
    const actorOf = (page: typeof forA, kind: string) =>
      page.value?.items.some((item) => item.actor.kind === kind);
    expect(actorOf(forA, 'user')).toBe(true);
    expect(forA.value?.items.every((item) => item.correlationId !== '')).toBe(true);
  });

  it('refuses a caller without view_audit and reads the record history only with the module permission', async () => {
    world = createWorld({ pipeline: { newId: () => 'shared-local-id' } });
    const { platform } = world;
    const { a, auditorA, editorA } = await twoCompanies(world);
    await world.releasedFile(a.admin, 'alfa.jpg', jpeg('alfa'));
    const denied = await platform.auditQuery.list(editorA.token, corr(), {});
    expect(denied.error).toMatchObject({ code: 'forbidden', status: 403 });
    expect((await platform.auditQuery.reconciliation(editorA.token, corr(), {})).error?.code).toBe(
      'forbidden',
    );
    const asAdmin = await platform.auditQuery.forEntity(
      a.admin.token,
      corr(),
      'file',
      'shared-local-id',
      {},
    );
    expect(asAdmin.value?.items.length).toBeGreaterThan(0);
    // The auditor reads `view`, which the file module needs; an incident needs `incidents:view`.
    expect(
      (await platform.auditQuery.forEntity(auditorA.token, corr(), 'file', 'shared-local-id', {}))
        .ok,
    ).toBe(true);
    expect(
      (await platform.auditQuery.forEntity(auditorA.token, corr(), 'incident', 'x', {})).error
        ?.code,
    ).toBe('forbidden');
  });

  it('reads nothing once the session is gone', async () => {
    world = createWorld();
    const { a } = await twoCompanies(world);
    await world.platform.signOut(a.admin.token);
    expect((await world.platform.auditQuery.list(a.admin.token, corr(), {})).error).toMatchObject({
      status: 401,
    });
  });
});
