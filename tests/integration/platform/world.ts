import { vi } from 'vitest';
import {
  FakeOidcVerifier,
  FakeScanner,
  InMemoryAuditStore,
  InMemoryObjectStorage,
  InMemoryOutboxStore,
  InMemoryTenantStore,
  createPlatform,
  type Platform,
  type PlatformOptions,
  type RoleName,
} from '../../../apps/api/composition/src/index.js';

/** Synthetic JPEG: valid signature plus a tag so each file has distinct bytes. */
export const jpeg = (tag: string): Uint8Array =>
  Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.from(tag)]);

export interface Session {
  readonly token: string;
  readonly identityId: string;
  readonly tenantId: string;
  readonly subject: string;
}

export interface TenantHandle {
  readonly tenantId: string;
  readonly admin: Session;
}

let correlations = 0;
export const corr = (): string => `corr-${(correlations += 1)}`;

export const START = new Date('2026-10-06T12:00:00.000Z');

/**
 * Builds a platform with in-memory adapters and a controllable clock (only `Date` is faked, so
 * promises keep working). Call `world.dispose()` in `afterEach`.
 */
export function createWorld(overrides: Partial<Omit<PlatformOptions, 'verifier' | 'issuer'>> = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  const verifier = new FakeOidcVerifier();
  const scanner = new FakeScanner();
  const storage = new InMemoryObjectStorage();
  const audit = new InMemoryAuditStore();
  const outbox = new InMemoryOutboxStore(() => Date.now());
  const tenants = new InMemoryTenantStore();
  const platform: Platform = createPlatform({
    verifier,
    issuer: verifier.issuer,
    grantSecret: 'synthetic-grant-secret-for-tests-0123456789',
    ...overrides,
    adapters: { scanner, storage, audit, outbox, tenants, ...overrides.adapters },
  });
  let subjects = 0;

  const principal = async (subject: string) => {
    const nonce = `nonce-${(subjects += 1)}`;
    const result = await platform.verifyPrincipal(verifier.issueCode(subject, nonce), nonce);
    if (!result.ok || !result.value) throw new Error('principal verification failed in fixture');
    return result.value;
  };

  const signIn = async (subject: string, tenantId: string): Promise<Session> => {
    const login = await platform.signIn(await principal(subject));
    if (!login.ok || !login.value) throw new Error(`fixture sign-in failed: ${login.error?.code}`);
    const context = await platform.session(login.value.token, corr());
    if (!context.ok || !context.value) throw new Error('fixture session failed');
    return { token: login.value.token, identityId: context.value.actor.subject, tenantId, subject };
  };

  const tenant = async (name: string, adminSubject: string): Promise<TenantHandle> => {
    const created = await platform.bootstrapTenant({
      name,
      adminPrincipal: await principal(adminSubject),
    });
    if (!created.ok || !created.value) throw new Error('fixture tenant failed');
    return {
      tenantId: created.value.tenantId,
      admin: await signIn(adminSubject, created.value.tenantId),
    };
  };

  const member = async (admin: Session, role: RoleName, subject: string): Promise<Session> => {
    const invited = await platform.inviteUser(admin.token, corr(), role);
    if (!invited.ok || !invited.value)
      throw new Error(`fixture invite failed: ${invited.error?.code}`);
    const accepted = await platform.acceptInvitation(
      invited.value.invitationToken,
      await principal(subject),
    );
    if (!accepted.ok) throw new Error(`fixture accept failed: ${accepted.error?.code}`);
    return signIn(subject, admin.tenantId);
  };

  /** Uploads, then runs the scan runner so the file is released. */
  const releasedFile = async (session: Session, name: string, bytes = jpeg(name)) => {
    const upload = await platform.files.upload(session.token, corr(), {
      name,
      contentType: 'image/jpeg',
      bytes,
    });
    if (!upload.ok || !upload.value)
      throw new Error(`fixture upload failed: ${upload.error?.code}`);
    await platform.runtime.runScans();
    return upload.value;
  };

  const advance = (ms: number): void => {
    vi.setSystemTime(new Date(Date.now() + ms));
  };

  return {
    platform,
    verifier,
    scanner,
    storage,
    audit,
    outbox,
    tenants,
    principal,
    signIn,
    tenant,
    member,
    releasedFile,
    advance,
    dispose: () => vi.useRealTimers(),
  };
}

export type World = ReturnType<typeof createWorld>;
