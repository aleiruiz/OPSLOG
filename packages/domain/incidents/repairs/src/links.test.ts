import { describe, expect, it } from 'vitest';
import { IncidentError, type Incident } from '../../cases/src/index.js';
import { REPAIR_RULES, RepairLinkService } from './links.js';
import {
  ADMIN,
  TENANT_A,
  TENANT_B,
  VIEWER,
  actorOf,
  caseIn,
  reload,
  setup,
  type World,
} from './test-support.js';

const KEY = 'key-link-00000001';
const fail = async (work: Promise<unknown>): Promise<IncidentError> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof IncidentError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
};
const link = (world: World, incident: Incident, orderId: string, key = KEY, actor = ADMIN) =>
  world.service.link(TENANT_A, actor, incident.id, { version: incident.version, orderId }, key);

describe('linking an order to a case (FR-102, invariants 2 and 3)', () => {
  it('links, bumps the version and writes timeline, audit and one allowlisted event without amounts', async () => {
    const world = setup();
    world.orders.add('order-1', { costs: [{ amountMinor: '1000000', currency: 'MXN' }] });
    const incident = await caseIn(world, 'under_review', {
      assumptionApproval: { by: 'user-x', at: '2026-10-13T17:00:00.000Z' },
      closeApproval: { by: 'user-x', at: '2026-10-13T17:00:00.000Z' },
    });
    const result = await link(world, incident, 'order-1');
    expect(result.incident.version).toBe(incident.version + 1);
    expect(result.incident.closeApproval).toBeNull();
    expect(result.incident.assumptionApproval).toBeNull();
    expect(result.link).toMatchObject({
      orderId: 'order-1',
      linkedBy: ADMIN.id,
      order: {
        id: 'order-1',
        description: 'Reparación sintética',
        status: 'in_progress',
        workshop: 'Taller Sintético',
      },
    });
    expect(JSON.stringify(result)).not.toContain('1000000');
    expect(await world.links.links(TENANT_A, incident.id)).toHaveLength(1);
    const entry = (await world.store.history(TENANT_A, incident.id)).at(-1);
    expect(entry).toMatchObject({
      command: 'repair_linked',
      from: 'under_review',
      to: 'under_review',
      before: { orderId: 'order-1' },
      changedFields: ['assumptionApproval', 'closeApproval', 'repairLinks'],
    });
    expect(world.store.audit.at(-1)?.action).toBe('incident.repair_linked');
    const events = world.store.events.filter((e) => e.event.type === 'incident.repair_linked');
    expect(events.map((e) => e.event.payload)).toEqual([
      { incidentId: incident.id, orderId: 'order-1', version: result.incident.version },
    ]);
    expect(JSON.stringify([entry, events])).not.toContain('MXN');
  });

  it('applies the link rules: tenant, vehicle, kind, state of the order and the single case', async () => {
    const world = setup();
    const incident = await caseIn(world, 'under_review');
    world.orders.add('foreign', {}, TENANT_B);
    world.orders.add('other-vehicle', { vehicleId: 'vehicle-2' });
    world.orders.add('preventive', { kind: 'preventive' });
    world.orders.add('cancelled', { status: 'cancelled' });
    world.orders.add('good');
    expect((await fail(link(world, incident, 'foreign'))).code).toBe('not_found');
    expect((await fail(link(world, incident, 'missing'))).code).toBe('not_found');
    expect(await fail(link(world, incident, 'other-vehicle'))).toMatchObject({
      code: 'rule_violation',
      rule: REPAIR_RULES.invalidAssociation,
    });
    expect((await fail(link(world, incident, 'preventive'))).rule).toBe(REPAIR_RULES.notCorrective);
    expect((await fail(link(world, incident, 'cancelled'))).rule).toBe(REPAIR_RULES.cancelled);
    const first = await link(world, incident, 'good');
    // The same order cannot be counted twice: not in another case, not again in this one.
    const other = await caseIn(world, 'repair');
    expect((await fail(link(world, other, 'good', 'key-other-0000002'))).code).toBe('duplicate');
    expect(
      (
        await fail(
          world.service.link(
            TENANT_A,
            ADMIN,
            incident.id,
            { version: first.incident.version, orderId: 'good' },
            'key-again-0000003',
          ),
        )
      ).code,
    ).toBe('duplicate');
    expect(await world.links.links(TENANT_A, other.id)).toEqual([]);
  });

  it('is allowed only in the six states, and refuses a stale version', async () => {
    const world = setup();
    world.orders.add('o');
    // A clean budget stands for the order, so the one linked in `repair` can leave again.
    world.evidence.add('budget', true);
    for (const status of [
      'under_review',
      'insurance_process',
      'insurance_rejected',
      'no_insurance',
      'repair',
      'reopened',
    ] as const) {
      const incident = await caseIn(world, status);
      const ok = await link(world, incident, 'o', `key-state-${status}-1`);
      await world.service.unlink(
        TENANT_A,
        ADMIN,
        incident.id,
        ok.link.id,
        { version: ok.incident.version },
        `key-state-${status}-2`,
      );
    }
    for (const status of ['draft', 'reported', 'resolved', 'closed', 'cancelled'] as const) {
      const incident = await caseIn(world, status);
      expect((await fail(link(world, incident, 'o', `key-no-${status}-1`))).code).toBe(
        'invalid_transition',
      );
    }
    const incident = await caseIn(world, 'under_review');
    const stale = await fail(
      world.service.link(TENANT_A, ADMIN, incident.id, { version: 99, orderId: 'o' }, KEY),
    );
    expect(stale.code).toBe('stale_version');
  });

  it('needs incidents:edit; the generic verbs, view alone and a mechanic scope grant nothing', async () => {
    const world = setup();
    world.orders.add('o');
    const incident = await caseIn(world, 'under_review');
    const generic = actorOf('00000000-0000-4000-8000-0000000000b1', [
      'view',
      'edit',
      'incidents:view',
    ]);
    expect((await fail(link(world, incident, 'o', KEY, VIEWER))).code).toBe('forbidden');
    expect((await fail(link(world, incident, 'o', KEY, generic))).code).toBe('forbidden');
    const nobody = actorOf('00000000-0000-4000-8000-0000000000b2', ['edit']);
    expect((await fail(link(world, incident, 'o', KEY, nobody))).code).toBe('forbidden');
    expect((await fail(world.service.list(TENANT_A, nobody, incident.id))).code).toBe('forbidden');
    const mechanic = actorOf('00000000-0000-4000-8000-0000000000b3', ['incidents:view'], true);
    expect((await fail(world.service.list(TENANT_A, mechanic, incident.id))).code).toBe(
      'not_found',
    );
    expect((await fail(world.service.list(TENANT_B, ADMIN, incident.id))).code).toBe('not_found');
    expect((await fail(world.service.list(TENANT_A, ADMIN, '../x'))).code).toBe('not_found');
    expect(await world.links.links(TENANT_A, incident.id)).toEqual([]);
  });

  it('requires the Idempotency-Key, replays the same body and refuses another body (case 10)', async () => {
    const world = setup();
    world.orders.add('o1');
    world.orders.add('o2');
    const incident = await caseIn(world, 'under_review');
    expect(
      (await fail(world.service.link(TENANT_A, ADMIN, incident.id, { version: 2, orderId: 'o1' })))
        .code,
    ).toBe('idempotency_key_required');
    expect((await fail(link(world, incident, 'o1', 'short'))).code).toBe('invalid_input');
    const first = await link(world, incident, 'o1');
    const replay = await link(world, incident, 'o1');
    expect(replay.link).toEqual(first.link);
    expect(replay.incident.version).toBe(first.incident.version);
    expect(
      world.store.events.filter((e) => e.event.type === 'incident.repair_linked'),
    ).toHaveLength(1);
    expect((await fail(link(world, incident, 'o2'))).code).toBe('idempotency_conflict');
    expect((await world.links.links(TENANT_A, incident.id)).map((l) => l.orderId)).toEqual(['o1']);
  });

  it('two concurrent calls with the same key make one link and one event', async () => {
    const world = setup();
    world.orders.add('o1');
    const incident = await caseIn(world, 'under_review');
    const [one, two] = await Promise.all([
      link(world, incident, 'o1'),
      link(world, incident, 'o1'),
    ]);
    expect(one.link.id).toBe(two.link.id);
    expect(await world.links.links(TENANT_A, incident.id)).toHaveLength(1);
    expect(
      world.store.events.filter((e) => e.event.type === 'incident.repair_linked'),
    ).toHaveLength(1);
  });

  it('answers a replay of an unlinked key with 409 and validates the body', async () => {
    const world = setup();
    world.orders.add('o1');
    const incident = await caseIn(world, 'under_review');
    const made = await link(world, incident, 'o1');
    await world.service.unlink(
      TENANT_A,
      ADMIN,
      incident.id,
      made.link.id,
      { version: made.incident.version },
      'key-unlink-0000001',
    );
    expect((await fail(link(world, incident, 'o1'))).code).toBe('duplicate');
    for (const body of [
      {},
      { version: 2 },
      { version: 2, orderId: 5 },
      { version: 2, orderId: 'o', x: 1 },
      [],
    ]) {
      const error = await fail(
        world.service.link(TENANT_A, ADMIN, incident.id, body, 'key-body-0000001'),
      );
      expect(error.code).toBe('invalid_input');
    }
  });
});

describe('unlinking an order', () => {
  it('removes the link, clears the approvals and keeps no order data', async () => {
    const world = setup();
    world.orders.add('o1');
    const incident = await caseIn(world, 'under_review');
    const made = await link(world, incident, 'o1');
    const approved = await reload(world as never, made.incident);
    const asApproved = await world.store.apply({
      incident: {
        ...approved,
        version: approved.version + 1,
        closeApproval: { by: 'user-x', at: '2026-10-13T17:00:00.000Z' },
      },
      expectedVersion: approved.version,
      folioYear: null,
      transitions: [],
      auditActions: [],
      events: [],
    });
    if (!asApproved.applied) throw new Error('fixture');
    const next = await world.service.unlink(
      TENANT_A,
      ADMIN,
      incident.id,
      made.link.id,
      { version: asApproved.incident.version },
      'key-unlink-0000001',
    );
    expect(next.closeApproval).toBeNull();
    expect(await world.links.links(TENANT_A, incident.id)).toEqual([]);
    expect((await world.store.history(TENANT_A, incident.id)).at(-1)).toMatchObject({
      command: 'repair_unlinked',
      before: { orderId: 'o1', linkId: made.link.id },
      changedFields: ['closeApproval', 'repairLinks'],
    });
    const events = world.store.events.filter((e) => e.event.type === 'incident.repair_unlinked');
    expect(events.map((e) => e.event.payload)).toEqual([
      { incidentId: incident.id, orderId: 'o1', version: next.version },
    ]);
  });

  it('answers 404 for an unknown link, 409 for the state, key rules and replay', async () => {
    const world = setup();
    world.orders.add('o1');
    const incident = await caseIn(world, 'under_review');
    const made = await link(world, incident, 'o1');
    const version = made.incident.version;
    const go = (id: string, key?: string, body: unknown = { version }) =>
      world.service.unlink(TENANT_A, ADMIN, incident.id, id, body, key);
    expect((await fail(go(made.link.id))).code).toBe('idempotency_key_required');
    expect((await fail(go('nope', 'key-unlink-0000001'))).code).toBe('not_found');
    expect((await fail(go('../x', 'key-unlink-0000002'))).code).toBe('not_found');
    expect((await fail(go(made.link.id, 'key-unlink-0000003', { version: 1 }))).code).toBe(
      'stale_version',
    );
    expect((await fail(go(made.link.id, 'bad'))).code).toBe('invalid_input');
    expect((await fail(go(made.link.id, 'key-unlink-0000003', {}))).code).toBe('invalid_input');
    const done = await go(made.link.id, 'key-unlink-0000004');
    const replay = await go(made.link.id, 'key-unlink-0000004');
    expect(replay.version).toBe(done.version);
    expect((await fail(go(made.link.id, 'key-unlink-0000004', { version: 7 }))).code).toBe(
      'idempotency_conflict',
    );
    const resolved = await caseIn(world, 'resolved');
    expect(
      (
        await fail(
          world.service.unlink(
            TENANT_A,
            ADMIN,
            resolved.id,
            'x',
            { version: resolved.version },
            'key-unlink-0000005',
          ),
        )
      ).code,
    ).toBe('invalid_transition');
    expect(
      (
        await fail(
          world.service.unlink(
            TENANT_A,
            VIEWER,
            incident.id,
            'x',
            { version },
            'key-unlink-0000006',
          ),
        )
      ).code,
    ).toBe('forbidden');
  });

  it('in repair, the last order leaves only while a clean budget stands in (ADR-0014, case 6)', async () => {
    const world = setup();
    world.orders.add('o1');
    world.orders.add('o2');
    const incident = await caseIn(world, 'repair');
    const one = await link(world, incident, 'o1', 'key-link-0000001');
    const two = await link(world, one.incident, 'o2', 'key-link-0000002');
    const unlink = (id: string, version: number, key: string) =>
      world.service.unlink(TENANT_A, ADMIN, incident.id, id, { version }, key);
    // One of two orders may go; the last one may not.
    const afterFirst = await unlink(one.link.id, two.incident.version, 'key-unlink-0000001');
    const refused = await fail(unlink(two.link.id, afterFirst.version, 'key-unlink-0000002'));
    expect(refused).toMatchObject({
      code: 'missing_requirements',
      missingRequirements: ['repair_order_or_budget'],
    });
    expect(await world.links.links(TENANT_A, incident.id)).toHaveLength(1);
    // A clean budget stands for the requirement: the order can leave.
    world.evidence.add('budget', true);
    await unlink(two.link.id, afterFirst.version, 'key-unlink-0000003');
    expect(await world.links.links(TENANT_A, incident.id)).toEqual([]);
  });

  it('a cancelled linked order does not count as the order of the requirement', async () => {
    const world = setup();
    world.orders.add('o1');
    world.orders.add('dead');
    const incident = await caseIn(world, 'repair');
    const one = await link(world, incident, 'o1', 'key-link-0000001');
    const two = await link(world, one.incident, 'dead', 'key-link-0000002');
    world.orders.add('dead', { status: 'cancelled' });
    const done = await world.service.unlink(
      TENANT_A,
      ADMIN,
      incident.id,
      two.link.id,
      { version: two.incident.version },
      'key-unlink-0000001',
    );
    expect(done.version).toBe(two.incident.version + 1);
  });
});

describe('listing links and reading orders', () => {
  it('lists the links with the order state and fails when a linked order cannot be read', async () => {
    const world = setup();
    world.orders.add('o1', { costs: [{ amountMinor: '5', currency: 'USD' }] });
    const incident = await caseIn(world, 'under_review');
    await link(world, incident, 'o1');
    const [view] = await world.service.list(TENANT_A, VIEWER, incident.id);
    expect(view?.order.status).toBe('in_progress');
    expect(JSON.stringify(view)).not.toContain('USD');
    world.orders.fail = true;
    await expect(world.service.list(TENANT_A, VIEWER, incident.id)).rejects.toThrow('unavailable');
    world.orders.fail = false;
    world.orders.orders.delete(`${TENANT_A}/o1`);
    await expect(world.service.list(TENANT_A, VIEWER, incident.id)).rejects.toThrow(
      'could not be read',
    );
    await expect(world.repairs.linkedOrders(TENANT_A, incident.id)).rejects.toThrow(
      'could not be read',
    );
  });

  it('the workflow port never says "unavailable" and reports state, version and whether it has costs', async () => {
    const world = setup();
    world.orders.add('o1', {
      costs: [{ amountMinor: '5', currency: 'USD' }],
      status: 'completed',
      version: 9,
    });
    world.orders.add('o2');
    const incident = await caseIn(world, 'repair');
    const one = await link(world, incident, 'o1', 'key-link-0000001');
    await link(world, one.incident, 'o2', 'key-link-0000002');
    expect(await world.repairs.linkedOrders(TENANT_A, incident.id)).toEqual({
      available: true,
      orders: [
        { orderId: 'o1', status: 'completed', version: 9, hasCosts: true },
        { orderId: 'o2', status: 'in_progress', version: 3, hasCosts: false },
      ],
    });
    expect(await world.repairs.linkedOrders(TENANT_B, incident.id)).toEqual({
      available: true,
      orders: [],
    });
  });
});

describe('races between commands of the same case', () => {
  const gate = () => {
    let open = (): void => undefined;
    const held = new Promise<void>((resolve) => (open = resolve));
    return { held, open };
  };

  it('a concurrent twin of a link with the same key gets the first answer', async () => {
    const world = setup();
    world.orders.add('o1');
    const incident = await caseIn(world, 'under_review');
    const { held, open } = gate();
    world.orders.hold = held;
    const both = Promise.all([link(world, incident, 'o1'), link(world, incident, 'o1')]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    open();
    const [one, two] = await both;
    expect(one.link.id).toBe(two.link.id);
    expect(
      world.store.events.filter((e) => e.event.type === 'incident.repair_linked'),
    ).toHaveLength(1);
  });

  it('two different links from the same version: one wins and the other is stale', async () => {
    const world = setup();
    world.orders.add('o1');
    world.orders.add('o2');
    const incident = await caseIn(world, 'under_review');
    const { held, open } = gate();
    world.orders.hold = held;
    const both = Promise.allSettled([
      link(world, incident, 'o1', 'key-race-0000001'),
      link(world, incident, 'o2', 'key-race-0000002'),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    open();
    const results = await both;
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as IncidentError).code).toBe('stale_version');
    expect(await world.links.links(TENANT_A, incident.id)).toHaveLength(1);
  });

  it('two links of the same order from the same version: the second is a duplicate, not a stale write', async () => {
    const world = setup();
    world.orders.add('o1');
    const a = await caseIn(world, 'under_review');
    const b = await caseIn(world, 'under_review');
    // The order is free when both read it; only the unique key tells them apart.
    const { held, open } = gate();
    world.orders.hold = held;
    const both = Promise.allSettled([
      link(world, a, 'o1', 'key-same-0000001'),
      link(world, b, 'o1', 'key-same-0000002'),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    open();
    const results = await both;
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as IncidentError).code).toBe('duplicate');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('a concurrent twin of an unlink with the same key answers the same version', async () => {
    const world = setup();
    world.orders.add('o1');
    const incident = await caseIn(world, 'repair');
    world.evidence.add('budget', true);
    const made = await link(world, incident, 'o1');
    const { held, open } = gate();
    const original = world.evidence.evidence.bind(world.evidence);
    world.evidence.evidence = async () => {
      await held;
      return original();
    };
    const go = () =>
      world.service.unlink(
        TENANT_A,
        ADMIN,
        incident.id,
        made.link.id,
        { version: made.incident.version },
        'key-unlink-0000001',
      );
    const both = Promise.all([go(), go()]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    open();
    const [one, two] = await both;
    expect(one.version).toBe(two.version);
    expect(
      world.store.events.filter((e) => e.event.type === 'incident.repair_unlinked'),
    ).toHaveLength(1);
  });

  it('finds the links that hold any of some orders, per tenant', async () => {
    const world = setup();
    world.orders.add('o1');
    const incident = await caseIn(world, 'under_review');
    await link(world, incident, 'o1');
    expect((await world.links.linksOfOrders(TENANT_A, ['o1', 'zz'])).map((l) => l.orderId)).toEqual(
      ['o1'],
    );
    expect(await world.links.linksOfOrders(TENANT_B, ['o1'])).toEqual([]);
    expect((await world.links.linkOfOrder(TENANT_A, 'o1'))?.incidentId).toBe(incident.id);
    expect(await world.links.linkOfOrder(TENANT_B, 'o1')).toBeNull();
  });
});

describe('two unlinks of the same link', () => {
  it('with different keys: one wins, the other finds the case moved', async () => {
    const world = setup();
    world.orders.add('o1');
    const incident = await caseIn(world, 'repair');
    world.evidence.add('budget', true);
    const made = await link(world, incident, 'o1');
    let open = (): void => undefined;
    const held = new Promise<void>((resolve) => (open = resolve));
    const original = world.evidence.evidence.bind(world.evidence);
    world.evidence.evidence = async () => {
      await held;
      return original();
    };
    const go = (key: string) =>
      world.service.unlink(
        TENANT_A,
        ADMIN,
        incident.id,
        made.link.id,
        { version: made.incident.version },
        key,
      );
    const both = Promise.allSettled([go('key-unlink-0000001'), go('key-unlink-0000002')]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    open();
    const results = await both;
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as IncidentError).code).toBe('stale_version');
  });
});

describe('defaults', () => {
  it('uses the real clock when none is injected', async () => {
    const world = setup();
    world.orders.add('o1');
    const incident = await caseIn(world, 'under_review');
    const plain = new RepairLinkService(world.store, world.links, world.orders, world.evidence);
    const made = await plain.link(
      TENANT_A,
      ADMIN,
      incident.id,
      { version: incident.version, orderId: 'o1' },
      KEY,
    );
    expect(Number.isNaN(Date.parse(made.link.linkedAt))).toBe(false);
  });
});
