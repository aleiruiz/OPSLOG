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
  appendLocalAuditAndDelivery,
} from '../../../packages/persistence/audit/src/index.js';
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

const stores = {
  'in-memory store': () => new InMemoryIdentityStore(),
  'TypeORM store (fake driver)': () =>
    new TypeOrmIdentityStore(asDataSource(new FakeDatabase(AUDIT_ENTITIES)), {
      appendAudit: (manager, event) =>
        appendLocalAuditAndDelivery(manager, { ...event, data: {} }).then(() => undefined),
    }),
} as const;

describe.each(Object.entries(stores))('accept racing revoke, %s', (_name, makeStore) => {
  it.each<Order>(['accept-first', 'revoke-first'])(
    'ends consistent when the second operation starts inside the first (%s)',
    async (order) => {
      const latency = withLatency(makeStore(), { activateInvitation: 1, revokeMembership: 10 });
      world = createWorld({
        adapters: {
          identityStore: latency.store as never,
          scanner: new FakeScanner(),
          storage: new InMemoryObjectStorage(),
          audit: new InMemoryAuditStore(),
          outbox: new InMemoryOutboxStore(() => Date.now()),
          tenants: new InMemoryTenantStore(),
        },
      });
      await raceAcceptAndRevoke(
        {
          platform: world.platform,
          principal: world.principal,
          findMembership: (tenantId, identityId) =>
            (latency.store as InMemoryIdentityStore).findMembership(tenantId, identityId),
          started: latency.started,
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
