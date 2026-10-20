import { describe, expect, it } from 'vitest';
import {
  operationalSources,
  type OperationalInputs,
} from '../../../apps/api/composition/src/platform/report-ops-sources.js';
import {
  ADMIN,
  TENANT_A,
  caseIn,
  line,
  setup,
  type World,
} from '../../../packages/domain/incidents/costs/src/test-support.js';
import type { WorkOrder } from '../../../packages/domain/maintenance/orders/src/index.js';
import type { ReportReader } from '../../../packages/domain/reports/src/index.js';

/**
 * The report sources read cases, links, ledgers and timelines in batches. Over the same data the
 * answer is identical to reading one id at a time, and the reads no longer grow with the rows.
 */
const ROWS = 40;
const reader: ReportReader = {
  tenantId: TENANT_A,
  actorId: 'subject-1',
  permissions: new Set([
    'view',
    'edit',
    'incidents:view',
    'incidents:edit',
    'incidents:view_costs',
  ]),
};

const orderRow = (id: string): WorkOrder =>
  ({
    id,
    kind: 'corrective',
    vehicleId: 'vehicle-1',
    planId: null,
    status: 'in_progress',
    description: null,
    workshopId: null,
    scheduledDate: null,
    actualDate: null,
    actualKm: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    closedAt: null,
    reopenCount: 0,
    costs: [],
  }) as unknown as WorkOrder;

async function seeded(world: World) {
  const incidentIds: string[] = [];
  const orderIds: string[] = [];
  for (let n = 0; n < ROWS; n += 1) {
    const orderId = `order-${n}`;
    world.orders.add(orderId, { costs: [{ amountMinor: String(100 + n), currency: 'MXN' }] });
    const incident = await caseIn(world, 'repair');
    const linked = await world.service.link(
      TENANT_A,
      ADMIN,
      incident.id,
      { version: incident.version, orderId },
      `key-batch-rep-l-${String(n).padStart(4, '0')}`,
    );
    await world.costService.update(
      TENANT_A,
      ADMIN,
      incident.id,
      { version: linked.incident.version, lines: [line('expense', 'towing', String(10 + n))] },
      `key-batch-rep-c-${String(n).padStart(4, '0')}`,
    );
    incidentIds.push(incident.id);
    orderIds.push(orderId);
  }
  return { incidentIds, orderIds };
}

/** The inputs over the in-memory stores; `batch: false` hides every batch method, like an older adapter. */
function inputs(world: World, orderIds: readonly string[], batch: boolean) {
  const calls: Record<string, number> = {};
  const count =
    <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      calls[name] = (calls[name] ?? 0) + 1;
      return fn(...a);
    };
  const { store, links, ledger } = world;
  const incidents = {
    get: count('incidents.get', store.get.bind(store)),
    history: count('incidents.history', store.history.bind(store)),
    ...(batch
      ? {
          getMany: count('incidents.getMany', store.getMany.bind(store)),
          historyMany: count('incidents.historyMany', store.historyMany.bind(store)),
        }
      : {}),
  };
  const repairs = {
    linkOfOrder: count('repairs.linkOfOrder', links.linkOfOrder.bind(links)),
    ...(batch
      ? { linksOfOrders: count('repairs.linksOfOrders', links.linksOfOrders.bind(links)) }
      : {}),
  };
  const reads = {
    read: count('ledger.read', ledger.read.bind(ledger)),
    ...(batch ? { readMany: count('ledger.readMany', ledger.readMany.bind(ledger)) } : {}),
  };
  const sources = operationalSources({
    orders: { list: async () => orderIds.map(orderRow) },
    plans: {},
    workshops: { list: async () => [] },
    incidents,
    repairs,
    ledger: reads,
    sla: { forIncidents: async () => new Map() },
    mechanicLinked: async () => false,
    now: () => new Date('2026-10-20T00:00:00.000Z'),
  } as unknown as OperationalInputs);
  return { sources, calls };
}

describe('report sources with batch reads', () => {
  it('give the same rows as one-by-one reads, with reads that do not grow with the rows', async () => {
    const world = setup();
    const { incidentIds, orderIds } = await seeded(world);
    const ids = [...incidentIds, 'unknown-case'];
    const batched = inputs(world, orderIds, true);
    const plain = inputs(world, orderIds, false);

    const run = async (it: ReturnType<typeof inputs>) => ({
      orders: await it.sources.workOrders(reader, { withCosts: true }),
      costs: [...(await it.sources.incidentCosts(reader, ids))],
      steps: [...(await it.sources.incidentSteps(reader, ids))],
      sla: [...(await it.sources.incidentSla(reader, ids))],
    });
    const [fast, slow] = [await run(batched), await run(plain)];

    expect(fast.orders).toHaveLength(ROWS);
    expect(fast.orders.every((o) => typeof o.incidentFolio === 'string')).toBe(true);
    expect(fast).toEqual(slow);
    expect(fast.costs).toHaveLength(ids.length);

    expect(batched.calls).toEqual({
      'repairs.linksOfOrders': 1,
      'incidents.getMany': 2,
      'ledger.readMany': 1,
      'incidents.historyMany': 1,
    });
    // One by one: a read per order, per case and per timeline.
    expect(plain.calls['repairs.linkOfOrder']).toBe(ROWS);
    expect(plain.calls['incidents.get']).toBe(ROWS + ids.length);
    expect(plain.calls['ledger.read']).toBe(ids.length);
    expect(plain.calls['incidents.history']).toBe(ids.length);
  });

  it('keeps the closed answers: no case permission, no reads at all', async () => {
    const world = setup();
    const { incidentIds, orderIds } = await seeded(world);
    const { sources, calls } = inputs(world, orderIds, true);
    const blind = { ...reader, permissions: new Set(['view', 'edit']) } as ReportReader;
    const orders = await sources.workOrders(blind, { withCosts: false });
    expect(orders.every((o) => o.incidentFolio === null)).toBe(true);
    expect((await sources.incidentCosts(blind, incidentIds)).size).toBe(0);
    expect((await sources.incidentSteps(blind, incidentIds)).size).toBe(0);
    expect(calls).toEqual({});
  });

  it('reads nothing for an empty list of rows', async () => {
    const world = setup();
    for (const batch of [true, false]) {
      const { sources, calls } = inputs(world, [], batch);
      expect(await sources.workOrders(reader, { withCosts: false })).toEqual([]);
      expect((await sources.incidentSteps(reader, [])).size).toBe(0);
      expect((await sources.incidentSla(reader, [])).size).toBe(0);
      expect(calls).toEqual({});
    }
  });
});
