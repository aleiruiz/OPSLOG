import { describe, expect, it, vi } from 'vitest';
import {
  TenantAccessDeniedError,
  opaqueTenantId,
  subjectId,
  type Membership,
  type Session,
  type SessionId,
  type Tenant,
  type TenantDatabaseLocation,
  type TenantId,
} from '@opslog/domain-tenants';
import {
  type TenantProvisioner,
  type TenantStore,
  type VerifiedTenantProvisioningAdapter,
} from '@opslog/persistence-tenancy';
import { TenantControlPlane } from './index.js';

const tenantId = opaqueTenantId();
const actor = subjectId('synthetic-subject');
const sessionId = 'synthetic-session' as SessionId;
const MIGRATION_VERSION = '2026100400020';

const tenant: Tenant = {
  id: tenantId,
  name: 'Synthetic tenant',
  status: 'active',
  createdAt: new Date(0),
};
const membership: Membership = { tenantId, subjectId: actor, status: 'active', version: 3 };
const location: TenantDatabaseLocation = {
  tenantId,
  databaseName: `opslog_t_${tenantId.replaceAll('-', '')}`,
  credentialRef: `tenant/${tenantId}/runtime`,
  secretVersion: 1,
  migrationVersion: MIGRATION_VERSION,
  runtimeRoleVerified: true,
  isolationProbeVerified: true,
  verifiedAt: new Date(0),
};
const session: Session = {
  id: sessionId,
  tenantId,
  subjectId: actor,
  authorizationVersion: 3,
  expiresAt: new Date(Date.now() + 60_000),
  revoked: false,
};

function store(overrides: Partial<TenantStore> = {}): TenantStore {
  return {
    getTenant: async (id: TenantId) => (id === tenantId ? tenant : undefined),
    getMembership: async (id: TenantId, subject) =>
      id === tenantId && subject === actor ? membership : undefined,
    getSession: async (id: SessionId) => (id === sessionId ? session : undefined),
    getLocation: async (id: TenantId) => (id === tenantId ? location : undefined),
    getJob: async () => undefined,
    projectMembership: async () => membership,
    saveSession: async () => undefined,
    setTenantStatus: async () => undefined,
    ...overrides,
  };
}

const adapter = {} as VerifiedTenantProvisioningAdapter;

describe('TenantControlPlane', () => {
  it('delegates provisioning to the provisioner with the request, key and verified adapter', async () => {
    const createAndProvision = vi.fn<TenantProvisioner['createAndProvision']>(async () => tenant);
    const plane = new TenantControlPlane({ createAndProvision }, store(), adapter);

    await expect(plane.provision({ name: 'Acme' }, 'idem-1')).resolves.toBe(tenant);

    expect(createAndProvision).toHaveBeenCalledTimes(1);
    expect(createAndProvision).toHaveBeenCalledWith({ name: 'Acme' }, 'idem-1', adapter);
  });

  it('propagates provisioning failures unchanged', async () => {
    const failure = new Error('provisioning backend unavailable');
    const plane = new TenantControlPlane(
      {
        createAndProvision: async () => {
          throw failure;
        },
      },
      store(),
      adapter,
    );
    await expect(plane.provision({ name: 'Acme' }, 'idem-1')).rejects.toBe(failure);
  });

  it('resolves the context from central state, ignoring tenant hints in the request', async () => {
    const plane = new TenantControlPlane(
      { createAndProvision: async () => tenant },
      store(),
      adapter,
    );

    const context = await plane.resolveContext({
      sessionId,
      headers: { 'x-tenant-id': opaqueTenantId() },
      body: { tenantId: opaqueTenantId() },
      query: { tenantId: opaqueTenantId() },
    });

    expect(context.tenantId).toBe(tenantId);
    expect(context.actor).toEqual({ subjectId: actor, membershipVersion: 3 });
    expect(context.database).toEqual(location);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it('builds its resolver from the injected store', async () => {
    const getSession = vi.fn(async () => session);
    const plane = new TenantControlPlane(
      { createAndProvision: async () => tenant },
      store({ getSession }),
      adapter,
    );
    await plane.resolveContext({ sessionId });
    expect(getSession).toHaveBeenCalledWith(sessionId);
  });

  it.each([
    ['unknown session', { sessionId: 'nope' as SessionId }],
    ['revoked session', { sessionId, revoke: true }],
  ])('denies access uniformly for %s', async (_label, input) => {
    const revoke = 'revoke' in input;
    const plane = new TenantControlPlane(
      { createAndProvision: async () => tenant },
      store(revoke ? { getSession: async () => ({ ...session, revoked: true }) } : {}),
      adapter,
    );
    await expect(plane.resolveContext({ sessionId: input.sessionId })).rejects.toBeInstanceOf(
      TenantAccessDeniedError,
    );
  });

  it('denies a suspended tenant', async () => {
    const plane = new TenantControlPlane(
      { createAndProvision: async () => tenant },
      store({ getTenant: async () => ({ ...tenant, status: 'suspended' }) }),
      adapter,
    );
    await expect(plane.resolveContext({ sessionId })).rejects.toBeInstanceOf(
      TenantAccessDeniedError,
    );
  });
});
