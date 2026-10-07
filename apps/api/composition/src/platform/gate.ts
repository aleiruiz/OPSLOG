import { createHash } from 'node:crypto';
import {
  AuthError,
  IdentityService,
  opaqueTokenGenerator,
  type IdentityStore,
  type RecoveryNotifier,
  type TenantContext,
} from '../../../../../packages/domain/identity/src/index.js';
import type { SessionId } from '../../../../../packages/domain/tenants/src/index.js';
import { TenantContextResolver } from '../../../../../packages/persistence/tenancy/src/index.js';
import type { InMemoryTenantStore } from '../tenancy.js';

/** Opaque id of the control-plane session that mirrors one identity session token. */
export const sessionIdOf = (token: string): SessionId =>
  createHash('sha256').update(token, 'utf8').digest('hex') as SessionId;

/**
 * Re-checks, on every authenticated call, that the control plane still considers the session
 * valid: tenant active, membership active at the same projection version, location verified.
 * Fails closed with the same error as any other authentication failure.
 */
export class TenantGate {
  private readonly resolver: TenantContextResolver;
  public constructor(store: InMemoryTenantStore) {
    this.resolver = new TenantContextResolver(store);
  }
  public async assertActive(token: string, context: TenantContext): Promise<void> {
    let resolved: Awaited<ReturnType<TenantContextResolver['resolve']>>;
    try {
      resolved = await this.resolver.resolve({ sessionId: sessionIdOf(token) });
    } catch {
      throw new AuthError('unauthorized');
    }
    if (
      resolved.tenantId !== context.tenantId ||
      resolved.actor.subjectId !== context.actor.subject
    )
      throw new AuthError('unauthorized');
  }
}

/**
 * Identity service whose `authenticate` also passes the tenant gate. Every API built on it
 * (auth, files, admin) therefore rejects suspended tenants and stale control-plane sessions.
 */
export class GatedIdentityService extends IdentityService {
  public constructor(
    store: IdentityStore,
    notifier: RecoveryNotifier,
    private readonly gate: TenantGate,
    now: () => Date,
  ) {
    super(store, notifier, opaqueTokenGenerator, now);
  }
  public override async authenticate(token: string, correlationId: string): Promise<TenantContext> {
    const context = await super.authenticate(token, correlationId);
    await this.gate.assertActive(token, context);
    return context;
  }
}
