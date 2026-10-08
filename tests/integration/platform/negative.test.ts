import { afterEach, describe, expect, it } from 'vitest';
import { DownloadGrants } from '../../../apps/api/composition/src/index.js';
import { corr, createWorld, jpeg, type World } from './world.js';

let world: World;
afterEach(() => world.dispose());

const HOUR = 3_600_000;
const SECRET = 'synthetic-grant-secret-for-tests-0123456789';

async function fixture(w: World) {
  const a = await w.tenant('Empresa Alfa', 'subject-admin-a');
  const b = await w.tenant('Empresa Beta', 'subject-admin-b');
  const editor = await w.member(a.admin, 'editor', 'subject-editor-a');
  const peer = await w.member(a.admin, 'editor', 'subject-peer-a');
  const file = await w.releasedFile(editor, 'alpha.jpg', jpeg('alpha'));
  return { a, b, editor, peer, file };
}

describe('forged, expired and misused grants', () => {
  it('rejects a tampered, foreign-secret, truncated or malformed grant', async () => {
    world = createWorld();
    const { platform } = world;
    const { a, editor, file } = await fixture(world);
    const issued = await platform.files.createDownloadGrant(editor.token, corr(), file.id);
    const grant = issued.value!.grant;
    const [payload, signature] = grant.split('.') as [string, string];

    // Swap the tenant inside the signed payload: the signature no longer matches.
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const forgedPayload = Buffer.from(JSON.stringify({ ...claims, t: 'other-tenant' })).toString(
      'base64url',
    );
    // A grant signed with another secret, for the right tenant, file and actor.
    const foreign = new DownloadGrants(
      'another-secret-another-secret-another-secret',
      () => new Date(),
    ).issue({
      tenantId: a.tenantId,
      fileId: file.id,
      subject: editor.identityId,
    });

    const bad: unknown[] = [
      `${forgedPayload}.${signature}`,
      foreign.token,
      grant.slice(0, grant.length - 4),
      `${payload}.`,
      payload,
      'not-a-grant',
      '',
      `${grant}.extra`,
      null,
      42,
      { grant },
    ];
    for (const value of bad) {
      const result = await platform.files.download(editor.token, corr(), value as string);
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({ code: 'unauthorized', status: 401 });
    }
    // The genuine grant still works afterwards: rejections have no side effects.
    expect((await platform.files.download(editor.token, corr(), grant)).ok).toBe(true);
  });

  it('rejects a grant after its expiry, and one issued to another actor of the same tenant', async () => {
    world = createWorld();
    const { platform } = world;
    const { editor, peer, file } = await fixture(world);
    const issued = (await platform.files.createDownloadGrant(editor.token, corr(), file.id)).value!;
    // Same tenant, different actor: looks like an unknown file.
    expect((await platform.files.download(peer.token, corr(), issued.grant)).error?.code).toBe(
      'not_found',
    );
    world.advance(16 * 60_000);
    expect((await platform.files.download(editor.token, corr(), issued.grant)).error?.code).toBe(
      'unauthorized',
    );
    // A long ttl is not configurable beyond 15 minutes.
    expect(() => new DownloadGrants(SECRET, () => new Date(), 16 * 60)).toThrow();
  });
});

describe('cross-tenant ids and hostile identifiers', () => {
  it('treats path-like, oversized and foreign ids as invalid or absent', async () => {
    world = createWorld();
    const { platform } = world;
    const { a, b, editor, file } = await fixture(world);
    const hostile = [
      `../${b.tenantId}/quarantine/originals/x`,
      `${a.tenantId}/${file.id}`,
      'tenants/other/released/originals/x',
      `${file.id}\u0000`,
      'x'.repeat(500),
      '',
    ];
    for (const id of hostile) {
      const status = await platform.files.status(editor.token, corr(), id);
      const grant = await platform.files.createDownloadGrant(editor.token, corr(), id);
      expect(status.error?.code).toBe('invalid_input');
      expect(grant.error?.code).toBe('invalid_input');
    }
    // A tenant id, a user id or a random id used as a file id is simply absent.
    for (const id of [b.tenantId, a.admin.identityId, 'file-00000000']) {
      expect((await platform.files.status(editor.token, corr(), id)).error?.code).toBe('not_found');
    }
    // The audit trail never records a hostile id verbatim.
    const trail = JSON.stringify(world.audit.snapshotForTesting(a.tenantId));
    expect(trail).not.toContain('../');
    expect(trail).not.toContain('tenants/other');
  });

  it('rejects tampered, empty and foreign session tokens', async () => {
    world = createWorld();
    const { platform } = world;
    const { b, editor } = await fixture(world);
    for (const token of [`${editor.token}x`, editor.token.slice(1), '', ' ', 'a'.repeat(300)]) {
      expect((await platform.session(token, corr())).error?.code).toBe('unauthorized');
    }
    expect((await platform.session(editor.token, '')).error?.code).toBe('unauthorized');
    // A token is bound to its own tenant; B's admin token never reaches A's data.
    const mine = (await platform.session(b.admin.token, corr())).value!;
    expect(mine.tenantId).toBe(b.tenantId);
  });
});

describe('forged principals, invitations and bootstrap', () => {
  it('refuses unverified principals and single-use verifier codes', async () => {
    world = createWorld();
    const { platform, verifier } = world;
    const { editor } = await fixture(world);
    // Plain objects with provider/subject are not sealed principals.
    const forged = { provider: verifier.issuer, subject: editor.subject };
    expect((await platform.signIn(forged)).error?.code).toBe('unauthorized');
    expect(
      (await platform.bootstrapTenant({ name: 'Empresa Falsa', adminPrincipal: forged })).error
        ?.code,
    ).toBe('unauthorized');
    expect((await platform.acceptInvitation('whatever', forged)).error?.code).toBe('unauthorized');
    expect(world.tenants.all()).toHaveLength(2);

    const code = verifier.issueCode('subject-x', 'nonce-x');
    expect((await platform.verifyPrincipal(code, 'nonce-x')).ok).toBe(true);
    expect((await platform.verifyPrincipal(code, 'nonce-x')).error?.code).toBe('unauthorized');
    const wrongNonce = verifier.issueCode('subject-y', 'nonce-y');
    expect((await platform.verifyPrincipal(wrongNonce, 'other')).error?.code).toBe('unauthorized');
    const wrongIssuer = verifier.issueCode('subject-z', 'nonce-z', { issuer: 'https://evil.test' });
    expect((await platform.verifyPrincipal(wrongIssuer, 'nonce-z')).error?.code).toBe(
      'unauthorized',
    );
    expect((await platform.verifyPrincipal('   ', 'nonce')).error?.code).toBe('unauthorized');
  });

  it('allows an invitation once, and not after it expired or for another principal link', async () => {
    world = createWorld();
    const { platform } = world;
    const { a } = await fixture(world);
    const invited = (await platform.inviteUser(a.admin.token, corr(), 'viewer')).value!;
    const first = await platform.acceptInvitation(
      invited.invitationToken,
      await world.principal('subject-new'),
    );
    expect(first.ok).toBe(true);
    // Replay with the same or a different subject fails closed.
    for (const subject of ['subject-new', 'subject-other']) {
      const replay = await platform.acceptInvitation(
        invited.invitationToken,
        await world.principal(subject),
      );
      expect(replay.error?.code).toBe('unauthorized');
    }
    const late = (await platform.inviteUser(a.admin.token, corr(), 'viewer')).value!;
    world.advance(73 * HOUR);
    expect(
      (await platform.acceptInvitation(late.invitationToken, await world.principal('subject-late')))
        .error?.code,
    ).toBe('unauthorized');
  });

  it('does not grant access through an invitation that did not come from inviteUser', async () => {
    world = createWorld();
    const { platform } = world;
    const { a } = await fixture(world);
    const direct = await platform.identity.issueInvitation(a.tenantId);
    const accepted = await platform.acceptInvitation(
      direct.token,
      await world.principal('subject-direct'),
    );
    expect(accepted.error?.code).toBe('forbidden');
    // The membership was revoked again, so a login finds no active tenant.
    expect((await platform.signIn(await world.principal('subject-direct'))).ok).toBe(false);
  });

  it('validates the tenant name after authorization and before provisioning', async () => {
    world = createWorld();
    const { platform } = world;
    const adminPrincipal = await world.principal('subject-admin-a');
    for (const name of [
      '',
      '   ',
      'x'.repeat(161),
      `  ${'x'.repeat(161)}  `,
      42,
      null,
      undefined,
    ]) {
      const result = await platform.bootstrapTenant({ name: name as string, adminPrincipal });
      expect(result.error?.code).toBe('invalid_input');
    }
    expect(world.tenants.all()).toHaveLength(0);
    // Authorization comes first: a forged principal is unauthorized even with a bad name.
    expect((await platform.bootstrapTenant({ name: '', adminPrincipal: {} })).error?.code).toBe(
      'unauthorized',
    );
    const edge = await platform.bootstrapTenant({ name: `  ${'x'.repeat(160)}  `, adminPrincipal });
    expect(edge.ok).toBe(true);
  });

  it('marks a tenant failed and never serves it when its administrator cannot be activated', async () => {
    world = createWorld();
    const { platform } = world;
    await world.tenant('Empresa Alfa', 'subject-admin-a');
    // The subject is already linked to another identity, so the new tenant has no valid admin.
    const failed = await platform.bootstrapTenant({
      name: 'Empresa Duplicada',
      adminPrincipal: await world.principal('subject-admin-a'),
    });
    expect(failed.ok).toBe(false);
    const broken = world.tenants.all().find((tenant) => tenant.name === 'Empresa Duplicada')!;
    expect(broken.status).toBe('failed');
    expect(world.tenants.status(broken.id)).toBe('suspended');
    expect(world.tenants.status('unknown-tenant')).toBe('missing');
  });
});

describe('last administrator and concurrent administration', () => {
  it('refuses to remove or demote the only administrator', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    expect(
      (await platform.removeMember(a.admin.token, corr(), a.admin.identityId)).error,
    ).toMatchObject({ code: 'last_admin', status: 409 });
    expect(
      (await platform.changeRole(a.admin.token, corr(), a.admin.identityId, 'viewer')).error?.code,
    ).toBe('last_admin');
    expect((await platform.session(a.admin.token, corr())).ok).toBe(true);
    expect(platform.access.activeAdmins(a.tenantId)).toEqual([a.admin.identityId]);
  });

  it.each([1, 2, 3, 4, 5])(
    'keeps one administrator when two admins remove each other concurrently (run %i)',
    async () => {
      world = createWorld();
      const { platform } = world;
      const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
      const second = await world.member(a.admin, 'admin', 'subject-admin-a2');
      const results = await Promise.all([
        platform.removeMember(a.admin.token, corr(), second.identityId),
        platform.removeMember(second.token, corr(), a.admin.identityId),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const loser = results.find((result) => !result.ok)!;
      expect(['last_admin', 'unauthorized']).toContain(loser.error?.code);
      expect(platform.access.activeAdmins(a.tenantId)).toHaveLength(1);
    },
  );

  it('keeps one administrator when a removal races a demotion', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const second = await world.member(a.admin, 'admin', 'subject-admin-a2');
    const results = await Promise.all([
      platform.changeRole(a.admin.token, corr(), second.identityId, 'viewer'),
      platform.changeRole(second.token, corr(), a.admin.identityId, 'viewer'),
      platform.removeMember(a.admin.token, corr(), second.identityId),
    ]);
    expect(results.filter((result) => result.ok).length).toBeGreaterThanOrEqual(1);
    expect(platform.access.activeAdmins(a.tenantId).length).toBeGreaterThanOrEqual(1);
  });

  it('does not let a revoked admin act on a change queued behind the one that revoked it', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const second = await world.member(a.admin, 'admin', 'subject-admin-a2');
    const third = await world.member(a.admin, 'editor', 'subject-editor-a');
    const [removal, late] = await Promise.all([
      platform.removeMember(a.admin.token, corr(), second.identityId),
      platform.changeRole(second.token, corr(), third.identityId, 'admin'),
    ]);
    expect(removal.ok).toBe(true);
    expect(late.ok).toBe(false);
    expect(platform.access.roleOf(a.tenantId, third.identityId)).toBe('editor');
  });

  it('rejects invalid administrative input', async () => {
    world = createWorld();
    const { platform } = world;
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    expect((await platform.removeMember(a.admin.token, corr(), '')).error?.code).toBe(
      'invalid_input',
    );
    expect((await platform.removeMember(a.admin.token, corr(), 'missing-id')).error?.code).toBe(
      'not_found',
    );
    expect(
      (await platform.changeRole(a.admin.token, corr(), a.admin.identityId, 'root' as never)).error
        ?.code,
    ).toBe('invalid_input');
    expect(
      (await platform.changeRole(a.admin.token, corr(), 'missing-id', 'viewer')).error?.code,
    ).toBe('not_found');
  });
});
