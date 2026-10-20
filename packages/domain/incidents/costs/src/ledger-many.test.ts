import { describe, expect, it } from 'vitest';
import { CostLedger } from './ledger.js';
import { ADMIN, TENANT_A, TENANT_B, caseIn, line, setup, type World } from './test-support.js';

/** Three cases: two with an order and own lines (two currencies), one without anything. */
async function seeded(world: World) {
  world.orders.add('o1', { costs: [{ amountMinor: '1000', currency: 'MXN' }] });
  world.orders.add('o2', { costs: [{ amountMinor: '50', currency: 'USD' }] });
  const ids: string[] = [];
  for (const [n, orderId] of [
    ['1', 'o1'],
    ['2', 'o2'],
    ['3', null],
  ] as const) {
    const incident = await caseIn(world, 'repair');
    ids.push(incident.id);
    let version = incident.version;
    if (orderId)
      version = (
        await world.service.link(
          TENANT_A,
          ADMIN,
          incident.id,
          { version, orderId },
          `key-many-l-${n}0000`,
        )
      ).incident.version;
    if (n !== '3')
      await world.costService.update(
        TENANT_A,
        ADMIN,
        incident.id,
        {
          version,
          lines: [line('expense', 'towing', '300'), line('recovery', 'insurer', '20', 'USD')],
        },
        `key-many-c-${n}0000`,
      );
  }
  // The order is cancelled after it was linked: it stays linked but no longer counts.
  world.orders.add('o2', { costs: [{ amountMinor: '50', currency: 'USD' }], status: 'cancelled' });
  return ids;
}

describe('CostLedger.readMany', () => {
  it('equals read for every case with a bounded number of store reads', async () => {
    const world = setup();
    const ids = await seeded(world);
    const calls = { lines: 0, links: 0, linesMany: 0, linksMany: 0 };
    const { costs, links } = world;
    const lines = costs.lines.bind(costs);
    const linesMany = costs.linesOfIncidents.bind(costs);
    const linksOf = links.links.bind(links);
    const linksMany = links.linksOfIncidents.bind(links);
    costs.lines = async (...a) => ((calls.lines += 1), lines(...a));
    costs.linesOfIncidents = async (...a) => ((calls.linesMany += 1), linesMany(...a));
    links.links = async (...a) => ((calls.links += 1), linksOf(...a));
    links.linksOfIncidents = async (...a) => ((calls.linksMany += 1), linksMany(...a));

    const many = await world.ledger.readMany(TENANT_A, [...ids, ids[0] as string, 'missing']);
    expect(calls).toEqual({ lines: 0, links: 0, linesMany: 1, linksMany: 1 });
    expect([...many.keys()].sort()).toEqual([...ids, 'missing'].sort());
    for (const id of [...ids, 'missing'])
      expect(many.get(id)).toEqual(await world.ledger.read(TENANT_A, id));
    // The cancelled order is no repair; the empty case reads as no lines and no links.
    expect(many.get(ids[1] as string)?.counted).toEqual([]);
    expect(many.get(ids[2] as string)).toMatchObject({ lines: [], links: [], totals: [] });
    expect(
      [...(await world.ledger.readMany(TENANT_B, ids)).values()].every((r) => r.lines.length === 0),
    ).toBe(true);
  });

  it('reads one case at a time when the stores have no batch reads, with the same answer', async () => {
    const world = setup();
    const ids = await seeded(world);
    const plain = new CostLedger(
      { lines: (...a: Parameters<typeof world.costs.lines>) => world.costs.lines(...a) } as never,
      { links: (...a: Parameters<typeof world.links.links>) => world.links.links(...a) },
      world.orders,
    );
    const many = await plain.readMany(TENANT_A, ids);
    for (const id of ids) expect(many.get(id)).toEqual(await world.ledger.read(TENANT_A, id));
  });
});
