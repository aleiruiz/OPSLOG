import { describe, expect, it } from 'vitest';
import { closedOrders } from './ledger.js';
import { ADMIN, NOW, TENANT_A, TENANT_B, caseIn, line, setup } from './test-support.js';

const linkKey = (n: number) => `key-ledger-link-${String(n).padStart(4, '0')}`;

describe('the cost ports of the workflow', () => {
  it('presence: a case with nothing has no costs; a line or a link makes it have them', async () => {
    const world = setup();
    world.orders.add('o1');
    const incident = await caseIn(world, 'under_review');
    expect(await world.ledger.presence(TENANT_A, incident.id)).toEqual({
      available: true,
      hasCosts: false,
      hasRepairLine: false,
    });
    const linked = await world.service.link(
      TENANT_A,
      ADMIN,
      incident.id,
      { version: incident.version, orderId: 'o1' },
      linkKey(1),
    );
    expect(await world.ledger.presence(TENANT_A, incident.id)).toMatchObject({
      hasCosts: true,
      hasRepairLine: false,
    });
    await world.costService.update(
      TENANT_A,
      ADMIN,
      incident.id,
      { version: linked.incident.version, lines: [line('expense', 'repair', '10')] },
      linkKey(2),
    );
    expect(await world.ledger.presence(TENANT_A, incident.id)).toMatchObject({
      hasCosts: true,
      hasRepairLine: true,
    });
    expect(await world.ledger.presence(TENANT_B, incident.id)).toMatchObject({ hasCosts: false });
  });

  it('totals: the formula of D20 per currency, with the order read live', async () => {
    const world = setup();
    world.orders.add('o1', { costs: [{ amountMinor: '1000000', currency: 'MXN' }] });
    const incident = await caseIn(world, 'repair');
    const linked = await world.service.link(
      TENANT_A,
      ADMIN,
      incident.id,
      { version: incident.version, orderId: 'o1' },
      linkKey(3),
    );
    expect(await world.ledger.totals(TENANT_A, incident.id)).toEqual({
      available: true,
      companyBorne: [{ currency: 'MXN', amountMinor: '1000000' }],
    });
    await world.costService.update(
      TENANT_A,
      ADMIN,
      incident.id,
      {
        version: linked.incident.version,
        lines: [
          line('expense', 'deductible', '200000'),
          line('expense', 'towing', '50000'),
          line('recovery', 'insurer', '800000'),
        ],
      },
      linkKey(4),
    );
    expect(await world.ledger.totals(TENANT_A, incident.id)).toEqual({
      available: true,
      companyBorne: [{ currency: 'MXN', amountMinor: '450000' }],
    });
  });

  it('snapshot: keeps the closed cycle once, in order, and the view tells when it later differs', async () => {
    const world = setup();
    world.orders.add('b', { costs: [{ amountMinor: '100', currency: 'MXN' }], status: 'closed' });
    world.orders.add('a', { costs: [{ amountMinor: '200', currency: 'MXN' }], status: 'closed' });
    world.orders.add('x', { costs: [{ amountMinor: '7', currency: 'MXN' }] });
    const incident = await caseIn(world, 'repair');
    let version = incident.version;
    for (const [i, orderId] of ['b', 'a', 'x'].entries()) {
      version = (
        await world.service.link(
          TENANT_A,
          ADMIN,
          incident.id,
          { version, orderId },
          linkKey(10 + i),
        )
      ).incident.version;
    }
    world.orders.add('x', { costs: [{ amountMinor: '7', currency: 'MXN' }], status: 'cancelled' });
    const request = {
      tenantId: TENANT_A,
      incidentId: incident.id,
      cycle: 1,
      closedAt: NOW.toISOString(),
    };
    await world.ledger.snapshot(request, undefined);
    expect(
      (await world.costService.get(TENANT_A, ADMIN, incident.id)).costs.differsFromLastClosure,
    ).toBe(false);
    // A second attempt for the same cycle keeps the first one.
    world.orders.add('b', { costs: [{ amountMinor: '999', currency: 'MXN' }], status: 'closed' });
    await world.ledger.snapshot(request, undefined);
    const [first, ...rest] = await world.costs.snapshots(TENANT_A, incident.id);
    expect(rest).toEqual([]);
    expect(first).toMatchObject({
      cycle: 1,
      totals: [{ currency: 'MXN', companyBorne: '300' }],
      orders: [
        { orderId: 'a', version: expect.any(Number), status: 'closed' },
        { orderId: 'b', version: expect.any(Number), status: 'closed' },
      ],
    });
    // The order changed after the closure: the view says so, the snapshot does not move.
    const view = await world.costService.get(TENANT_A, ADMIN, incident.id);
    expect(view.costs.differsFromLastClosure).toBe(true);
    expect(view.costs.snapshots).toHaveLength(1);
    expect(view.costs.snapshots[0]?.totals[0]?.companyBorne).toBe('300');
    expect(await world.costs.snapshots(TENANT_B, incident.id)).toEqual([]);
    expect(closedOrders({ counted: [] })).toEqual([]);
  });
});
