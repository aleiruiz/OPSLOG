import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHmac,
} from 'node:crypto';
import { promisify } from 'node:util';
import type {
  CredentialPort,
  IdentityRepository,
  IdentityUser,
  Invitation,
  Membership,
  PasswordReset,
  Session,
} from '../../../domain/identity/src/index.js';

const scrypt = promisify(scryptCallback);

export class InMemoryIdentityRepository implements IdentityRepository {
  private readonly users = new Map<string, IdentityUser>();
  private readonly memberships = new Map<string, Membership>();
  private readonly invitations = new Map<string, Invitation>();
  private readonly sessions = new Map<string, Session>();
  private readonly resets = new Map<string, PasswordReset>();

  public getUser(id: string) {
    return this.users.get(id);
  }
  public getUserByEmail(email: string) {
    return [...this.users.values()].find((user) => user.email === email);
  }
  public getMembership(tenantId: string, userId: string) {
    return this.memberships.get(`${tenantId}:${userId}`);
  }
  public countActiveAdmins(tenantId: string) {
    return [...this.memberships.values()].filter(
      (m) => m.tenantId === tenantId && m.active && m.roles.includes('company_admin'),
    ).length;
  }
  public saveUser(user: IdentityUser) {
    this.users.set(user.id, user);
  }
  public saveMembership(membership: Membership) {
    this.memberships.set(`${membership.tenantId}:${membership.userId}`, membership);
  }
  public saveInvitation(invitation: Invitation) {
    this.invitations.set(invitation.tokenDigest, invitation);
  }
  public getInvitationByDigest(digest: string) {
    return this.invitations.get(digest);
  }
  public saveSession(session: Session) {
    this.sessions.set(session.tokenDigest, session);
  }
  public getSessionByDigest(digest: string) {
    return this.sessions.get(digest);
  }
  public savePasswordReset(reset: PasswordReset) {
    this.resets.set(reset.tokenDigest, reset);
  }
  public getPasswordResetByDigest(digest: string) {
    return this.resets.get(digest);
  }
  public revokeUserSessions(userId: string) {
    for (const session of this.sessions.values())
      if (session.userId === userId) session.revokedAt = Date.now();
  }
  public withLock<T>(work: () => T): T {
    return work();
  }
}

export class NodeCredentialAdapter implements CredentialPort {
  private static readonly compromisedPasswords = new Set([
    'password1234',
    'password12345',
    'qwertyuiop12',
    'letmein12345',
  ]);

  public randomOpaque(): string {
    return randomBytes(32).toString('base64url');
  }
  public digestOpaque(value: string): string {
    return createHmac('sha256', 'opslog-sandbox-digest-key').update(value).digest('hex');
  }
  public async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = (await scrypt(password, salt, 64)) as Buffer;
    return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }
  public async verifyPassword(password: string, encoded: string): Promise<boolean> {
    const [, saltText, hashText] = encoded.split('$');
    if (!saltText || !hashText) return false;
    const derived = (await scrypt(password, Buffer.from(saltText, 'base64url'), 64)) as Buffer;
    const expected = Buffer.from(hashText, 'base64url');
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  }

  public async isPasswordCompromised(password: string): Promise<boolean> {
    return NodeCredentialAdapter.compromisedPasswords.has(password.toLowerCase());
  }
}

export class TotpAdapter {
  public verify(secret: string, code: string, now: number): boolean {
    if (!/^\d{6}$/.test(code)) return false;
    const counter = Math.floor(now / 30_000);
    return [-1, 0, 1].some((offset) => this.code(secret, counter + offset) === code);
  }
  private code(secret: string, counter: number): string {
    const key = Buffer.from(secret, 'base64url');
    const message = Buffer.alloc(8);
    message.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac('sha1', key).update(message).digest();
    const index = digest[digest.length - 1]! & 15;
    const value = (digest.readUInt32BE(index) & 0x7fffffff) % 1_000_000;
    return value.toString().padStart(6, '0');
  }
}

export const hashForTest = (value: string) => createHash('sha256').update(value).digest('hex');
