import { describe, expect, it } from 'vitest';
import {
  IdentityError,
  IdentityService,
  type IdentityRepository,
  type IdentityUser,
  type Invitation,
  type Membership,
  type PasswordReset,
  type Session,
} from './index.js';

class FakeCrypto {
  private n = 0;
  randomOpaque() {
    return `opaque-${++this.n}`;
  }
  digestOpaque(value: string) {
    return `digest:${value}`;
  }
  async hashPassword(value: string) {
    return `hash:${value}`;
  }
  async verifyPassword(value: string, hash: string) {
    return hash === `hash:${value}`;
  }
}
class FakeRepo implements IdentityRepository {
  users = new Map<string, IdentityUser>();
  memberships = new Map<string, Membership>();
  invitations = new Map<string, Invitation>();
  sessions = new Map<string, Session>();
  resets = new Map<string, PasswordReset>();
  getUser(id: string) {
    return this.users.get(id);
  }
  getUserByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email);
  }
  getMembership(t: string, u: string) {
    return this.memberships.get(`${t}:${u}`);
  }
  countActiveAdmins(t: string) {
    return [...this.memberships.values()].filter(
      (m) => m.tenantId === t && m.active && m.roles.includes('company_admin'),
    ).length;
  }
  saveUser(u: IdentityUser) {
    this.users.set(u.id, u);
  }
  saveMembership(m: Membership) {
    this.memberships.set(`${m.tenantId}:${m.userId}`, m);
  }
  saveInvitation(i: Invitation) {
    this.invitations.set(i.tokenDigest, i);
  }
  getInvitationByDigest(d: string) {
    return this.invitations.get(d);
  }
  saveSession(s: Session) {
    this.sessions.set(s.tokenDigest, s);
  }
  getSessionByDigest(d: string) {
    return this.sessions.get(d);
  }
  savePasswordReset(r: PasswordReset) {
    this.resets.set(r.tokenDigest, r);
  }
  getPasswordResetByDigest(d: string) {
    return this.resets.get(d);
  }
  revokeUserSessions(id: string) {
    for (const s of this.sessions.values()) if (s.userId === id) s.revokedAt = 1;
  }
  withLock<T>(work: () => T) {
    return work();
  }
}
const setup = () => {
  const repo = new FakeRepo();
  const crypto = new FakeCrypto();
  const service = new IdentityService(repo, crypto);
  const admin: IdentityUser = {
    id: 'admin',
    email: 'admin@example.test',
    status: 'active',
    passwordHash: 'hash:ValidPassword1',
    mfaRequired: false,
    mfaEnabled: false,
    mfaSecret: null,
    authorizationVersion: 1,
  };
  repo.saveUser(admin);
  repo.saveMembership({
    tenantId: 'A',
    userId: 'admin',
    roles: ['company_admin'],
    permissions: ['manage_users', 'view'],
    owner: true,
    active: true,
  });
  return { repo, service };
};

describe('CORE-AUTH', () => {
  it('expires invitations at 72 hours and blocks revoked ones', async () => {
    const { service, repo } = setup();
    const sent = await service.invite('admin', 'A', 'new@example.test', 0);
    expect(sent.invitationId).toBe([...repo.invitations.values()][0]?.id);
    expect(
      (await service.acceptInvitation(sent.token, 'ValidPassword1', 72 * 60 * 60 * 1000 - 1))
        .status,
    ).toBe('active');
    const expired = await service.invite('admin', 'A', 'expired@example.test', 0);
    await expect(
      service.acceptInvitation(expired.token, 'ValidPassword1', 72 * 60 * 60 * 1000),
    ).rejects.toMatchObject({ code: 'invalid_invitation' });
    const second = await service.invite('admin', 'A', 'other@example.test', 0);
    service.revokeInvitation('admin', 'A', second.token, 1);
    await expect(service.acceptInvitation(second.token, 'ValidPassword1', 2)).rejects.toMatchObject(
      { code: 'invalid_invitation' },
    );
  });

  it('activates the membership and atomically consumes the invitation', async () => {
    const { service, repo } = setup();
    const sent = await service.invite('admin', 'A', 'new@example.test', 0, ['viewer']);
    await service.acceptInvitation(sent.token, 'ValidPassword1', 1);
    const user = [...repo.users.values()].find((u) => u.email === 'new@example.test');
    expect(repo.getMembership('A', user!.id)?.active).toBe(true);
    await expect(
      service.acceptInvitation(sent.token, 'OtherValidPassword1', 2),
    ).rejects.toMatchObject({
      code: 'invalid_invitation',
    });
  });

  it('progressively locks repeated failed logins and clears the counter on success', async () => {
    const { service, repo } = setup();
    for (let attempt = 0; attempt < 5; attempt++)
      await expect(
        service.authenticate('admin@example.test', 'WrongPassword1', 'A', attempt),
      ).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(repo.getUser('admin')?.lockedUntil).toBe(15 * 60 * 1000 + 4);
    await expect(
      service.authenticate('admin@example.test', 'ValidPassword1', 'A', 5),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(
      service.authenticate('admin@example.test', 'ValidPassword1', 'A', 15 * 60 * 1000 + 5),
    ).resolves.toMatchObject({ userId: 'admin' });
    expect(repo.getUser('admin')?.failedLoginAttempts).toBe(0);
  });

  it('rejects malformed or duplicate roles before persisting them', async () => {
    const { service } = setup();
    await expect(
      service.invite('admin', 'A', 'new@example.test', 0, ['not-a-role' as never]),
    ).rejects.toMatchObject({ code: 'invalid_roles' });
    await expect(
      service.invite('admin', 'A', 'new@example.test', 0, ['viewer', 'viewer']),
    ).rejects.toMatchObject({ code: 'invalid_roles' });
  });
  it('prevents the last administrator from being removed, including concurrent attempts', () => {
    const { service, repo } = setup();
    expect(() => service.setRoles('admin', 'A', 'admin', ['viewer'])).toThrowError(
      new IdentityError('last_admin', 'The tenant must retain an administrator'),
    );
    expect(() => service.deactivate('admin', 'A', 'admin')).toThrowError('retain an administrator');
    expect(repo.getUser('admin')?.status).toBe('active');
  });
  it('revokes sessions after role changes and rejects ownership violations', async () => {
    const { service, repo } = setup();
    const member: IdentityUser = {
      id: 'member',
      email: 'member@example.test',
      status: 'active',
      passwordHash: 'hash:ValidPassword1',
      mfaRequired: false,
      mfaEnabled: false,
      mfaSecret: null,
      authorizationVersion: 1,
    };
    repo.saveUser(member);
    repo.saveMembership({
      tenantId: 'A',
      userId: 'member',
      roles: ['dispatcher'],
      permissions: ['view', 'edit'],
      owner: false,
      active: true,
    });
    const auth = await service.authenticate(member.email, 'ValidPassword1', 'A', 0);
    expect(() => service.authorize('member', 'A', 'edit', 'other')).toThrowError(
      'Ownership required',
    );
    service.setRoles('admin', 'A', 'member', ['dispatcher']);
    expect(() => service.validateSession(auth.token, 1)).toThrowError('Session is not valid');
  });
  it('enforces session idle expiry and one-time password recovery', async () => {
    const { service } = setup();
    const auth = await service.authenticate('admin@example.test', 'ValidPassword1', 'A', 0);
    expect(service.validateSession(auth.token, 100).userId).toBe('admin');
    expect(() => service.validateSession(auth.token, 8 * 60 * 60 * 1000 + 101)).toThrowError(
      'Session is not valid',
    );
    const reset = service.requestPasswordReset('admin@example.test', 0);
    expect(reset.token).not.toBeNull();
    await service.resetPassword(reset.token!, 'NewValidPassword1', 1);
    await expect(
      service.resetPassword(reset.token!, 'OtherValidPassword1', 2),
    ).rejects.toMatchObject({ code: 'invalid_reset' });
  });
});
