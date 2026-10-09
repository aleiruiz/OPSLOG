import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeScanner,
  InMemoryAuditStore,
  InMemoryObjectStorage,
  InMemoryOutboxStore,
  InMemoryTenantStore,
} from '../../../apps/api/composition/src/index.js';
import { InMemoryIdentityStore } from '../../../packages/domain/identity/src/index.js';
import {
  AUDIT_ENTITIES,
  AuditProjectionEntity,
  createMySqlAuditRuntime,
} from '../../../packages/persistence/audit/src/index.js';
import type { PersistedAuditEvent } from '../../../packages/platform/audit/src/index.js';
import { TypeOrmIdentityStore } from '../../../packages/persistence/identity/src/index.js';
import {
  FakeDatabase,
  asDataSource,
} from '../../../packages/persistence/identity/src/test-support/fake-database.js';
import { withLatency } from './latency.js';
import { raceAcceptAndRevoke, type Order } from './invitation-race.js';
import { createWorld, type World } from './world.js';

let world: World;
afterEach(() => world.dispose());

describe('withLatency', () => {
  it('signals the atomic-audit variants of invitation activation and revocation', async () => {
    world = createWorld();
    const latency = withLatency(
      {
        activateInvitationWithAudit: async () => 'activated',
        revokeMembershipWithAudit: async () => 'revoked',
      },
      { activateInvitation: 1, revokeMembership: 1 },
    );

    await expect(latency.store.activateInvitationWithAudit()).resolves.toBe('activated');
    await expect(latency.started('activateInvitation')).resolves.toBeUndefined();
    await expect(latency.store.revokeMembershipWithAudit()).resolves.toBe('revoked');
    await expect(latency.started('revokeMembership')).resolves.toBeUndefined();
  });
});

const stores = {
  'in-memory store': () => ({ store: new InMemoryIdentityStore(), db: undefined }),
  'TypeORM store (fake driver)': () => {
    const db = new FakeDatabase(AUDIT_ENTITIES);
    Object.defineProperty(db.options, 'database', { value: 'opslog_t_fake_race' });
    return { store: new TypeOrmIdentityStore(asDataSource(db)), db };
  },
} as const;

describe.each(Object.entries(stores))('accept racing revoke, %s', (_name, makeStore) => {
  it.each<Order>(['accept-first', 'revoke-first'])(
    'ends consistent when the second operation starts inside the first (%s)',
    async (order) => {
      const fixture = makeStore();
      const latency = withLatency(fixture.store, { activateInvitation: 1, revokeMembership: 10 });
      const tenants = new InMemoryTenantStore();
      const source = fixture.db ? asDataSource(fixture.db) : undefined;
      const auditRuntime = source
        ? createMySqlAuditRuntime({
            listTenantIds: () => tenants.all().map((tenant) => tenant.id),
            resolveRuntime: () => source,
            resolveRelay: () => source,
            resolveReader: () => source,
          })
        : undefined;
      if (fixture.db && auditRuntime) {
        // FakeDatabase intentionally lacks TypeORM QueryBuilder; keep append/relay real and read
        // the committed projection rows it produced for this fake-driver test.
        auditRuntime.audit.list = async (tenantId) => {
          const projection = fixture.db!.committed(
            AuditProjectionEntity,
          ) as unknown as AuditProjectionEntity[];
          return projection
            .filter((event) => event.tenantId === tenantId)
            .map(
              (event) =>
                ({
                  eventId: event.eventId,
                  tenantId: event.tenantId,
                  action: event.action,
                  entityType: event.entityType,
                  entityId: event.entityId,
                  occurredAt: event.occurredAt.toISOString(),
                  actor: { id: event.actorId, kind: event.actorKind },
                  correlationId: event.correlationId,
                  data: event.data,
                }) as PersistedAuditEvent,
            );
        };
      }
      world = createWorld({
        adapters: {
          identityStore: latency.store as never,
          scanner: new FakeScanner(),
          storage: new InMemoryObjectStorage(),
          audit: auditRuntime?.audit ?? new InMemoryAuditStore(),
          auditRelay: auditRuntime?.auditRelay ?? { runBatch: async () => 0 },
          outbox: auditRuntime?.outbox ?? new InMemoryOutboxStore(() => Date.now()),
          tenants,
        },
      });
      await raceAcceptAndRevoke(
        {
          platform: world.platform,
          principal: world.principal,
          findMembership: (tenantId, identityId) =>
            (latency.store as InMemoryIdentityStore).findMembership(tenantId, identityId),
          started: latency.started,
          ...(auditRuntime
            ? {
                flushAudit: async () => {
                  await auditRuntime.auditRelay.runBatch();
                },
              }
            : {}),
        },
        order,
        order,
      );
    },
  );
});

describe('accept racing a tenant suspension (same process)', () => {
  async function setup() {
    const identity = withLatency(new InMemoryIdentityStore(), { activateInvitation: 10 });
    const tenantStore = withLatency(new InMemoryTenantStore(), { setTenantStatus: 10 });
    world = createWorld({
      adapters: {
        identityStore: identity.store as never,
        tenants: tenantStore.store as never,
        scanner: new FakeScanner(),
        storage: new InMemoryObjectStorage(),
        audit: new InMemoryAuditStore(),
        outbox: new InMemoryOutboxStore(() => Date.now()),
      },
    });
    const a = await world.tenant('Empresa Alfa', 'subject-admin-a');
    const invited = (await world.platform.inviteUser(a.admin.token, 'c', 'editor')).value!;
    tenantStore.rearm('setTenantStatus');
    const actions = async () =>
      (await world.platform.audit.list(a.tenantId)).map((event) => event.action);
    return { a, invited, identity, tenantStore, actions, principal: world.principal };
  }

  it('lets an accept already in flight finish before the suspension takes effect', async () => {
    const t = await setup();
    const accept = world.platform.acceptInvitation(
      t.invited.invitationToken,
      await t.principal('subject-late'),
    );
    await t.identity.started('activateInvitation');
    const suspend = world.platform.suspendTenant(t.a.tenantId);
    const [accepted] = await Promise.all([accept, suspend]);
    expect(accepted.ok).toBe(true);
    expect(world.platform.tenants.status(t.a.tenantId)).toBe('suspended');
    expect(world.platform.access.roleOf(t.a.tenantId, t.invited.identityId)).toBe('editor');
    const actions = await t.actions();
    expect(actions.indexOf('user.joined')).toBeGreaterThan(-1);
    expect(actions.indexOf('user.joined')).toBeLessThan(actions.indexOf('tenant.suspended'));
  });

  it('blocks an accept that arrives while the suspension is in flight, without consuming it', async () => {
    const t = await setup();
    const suspend = world.platform.suspendTenant(t.a.tenantId);
    await t.tenantStore.started('setTenantStatus');
    const accept = world.platform.acceptInvitation(
      t.invited.invitationToken,
      await t.principal('subject-late'),
    );
    const [, accepted] = await Promise.all([suspend, accept]);
    expect(accepted.error?.code).toBe('unauthorized');
    expect(world.platform.access.hasPending(t.invited.identityId, t.a.tenantId)).toBe(true);
    expect(await t.actions()).not.toContain('user.joined');
    await world.platform.reactivateTenant(t.a.tenantId);
    expect(
      (
        await world.platform.acceptInvitation(
          t.invited.invitationToken,
          await t.principal('subject-late'),
        )
      ).ok,
    ).toBe(true);
  });
});
