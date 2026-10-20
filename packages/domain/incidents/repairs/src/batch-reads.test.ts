import { describe, expect, it } from 'vitest';
import { ADMIN, TENANT_A, TENANT_B, caseIn, setup } from './test-support.js';

describe('InMemoryIncidentRepairStore batch reads', () => {
  it('answers linksOfOrders and linksOfIncidents like linkOfOrder and links, for the tenant only', async () => {
    const world = setup();
    for (const id of ['o1', 'o2', 'o3']) world.orders.add(id);
    const first = await caseIn(world, 'under_review');
    const second = await caseIn(world, 'under_review');
    const idle = await caseIn(world, 'under_review');
    let version = first.version;
    for (const [n, orderId] of ['o1', 'o2'].entries())
      version = (
        await world.service.link(
          TENANT_A,
          ADMIN,
          first.id,
          { version, orderId },
          `key-batch-link-${n}0000`,
        )
      ).incident.version;
    await world.service.link(
      TENANT_A,
      ADMIN,
      second.id,
      { version: second.version, orderId: 'o3' },
      'key-batch-link-30000',
    );

    const byOrder = await world.links.linksOfOrders(TENANT_A, ['o1', 'o2', 'o3', 'o9']);
    expect([...byOrder.keys()].sort()).toEqual(['o1', 'o2', 'o3']);
    for (const [orderId, link] of byOrder)
      expect(link).toEqual(await world.links.linkOfOrder(TENANT_A, orderId));

    const ids = [first.id, second.id, idle.id];
    const byIncident = await world.links.linksOfIncidents(TENANT_A, ids);
    expect([...byIncident.keys()].sort()).toEqual([first.id, second.id].sort());
    for (const id of ids)
      expect(byIncident.get(id) ?? []).toEqual(await world.links.links(TENANT_A, id));

    expect((await world.links.linksOfOrders(TENANT_B, ['o1'])).size).toBe(0);
    expect((await world.links.linksOfIncidents(TENANT_B, ids)).size).toBe(0);
  });
});
