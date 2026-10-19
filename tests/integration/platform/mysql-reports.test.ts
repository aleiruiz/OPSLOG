import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operationalSources } from '../../../apps/api/composition/src/platform/report-ops-sources.js';
import { InMemoryAssignmentStore } from '../../../packages/domain/assignments/src/index.js';
import { InMemoryWorkshopStore } from '../../../packages/domain/maintenance/workshops/src/index.js';
import { InMemoryMaintenancePlanStore } from '../../../packages/domain/maintenance/plans/src/index.js';
import type { Permission } from '../../../packages/domain/identity/src/index.js';
import type {
  OperationalSources,
  ReportReader,
} from '../../../packages/domain/reports/src/index.js';
import { TypeOrmIncidentStore } from '../../../packages/persistence/incidents/cases/src/index.js';
import {
  adminUrl as incidentAdminUrl,
  startIncidentDatabase,
  type IncidentTestDatabase,
} from '../../../packages/persistence/incidents/cases/src/test-support/mysql.js';
import { TypeOrmWorkOrderStore } from '../../../packages/persistence/maintenance/orders/src/index.js';
import {
  startWorkOrderDatabase,
  type WorkOrderTestDatabase,
} from '../../../packages/persistence/maintenance/orders/src/test-support/mysql.js';
import { NOW, SIZES, seedIncidents, seedOrders } from './analytics-dataset.js';

/**
 * The maintenance and incident report reads on the real MySQL stores of both modules, over the
 * synthetic dataset of the dashboard (12.000 orders and 6.000 cases for one company, a few for the
 * other). Each module has its own database and restricted runtime account. CI: mysql service and
 * OPSLOG_TEST_MYSQL_ADMIN_URL; locally skipped when unset or older than 8.4.
 */
const suite = incidentAdminUrl ? describe : describe.skip;

const reader = (
  tenantId: string,
  permissions: readonly Permission[],
  actorId = 'subject-1',
): ReportReader => ({ tenantId, permissions: new Set(permissions), actorId });

suite('report reads on the real MySQL stores', () => {
  let orders: WorkOrderTestDatabase;
  let incidents: IncidentTestDatabase;
  const open: { destroy(): Promise<void> }[] = [];
  let sources: OperationalSources;
  let linked = false;
  const tenantA = randomUUID();

  beforeAll(async () => {
    [orders, incidents] = await Promise.all([
      startWorkOrderDatabase('rw'),
      startIncidentDatabase('rn'),
    ]);
    const orderSource = await orders.openOrders('a');
    const incidentSource = await incidents.openIncidents('a');
    open.push(orderSource, incidentSource);
    const areas = ['area-1', 'area-2'];
    await seedOrders(orderSource, tenantA);
    await seedIncidents(incidentSource, tenantA, areas);
    const incidentStore = new TypeOrmIncidentStore(incidentSource);
    sources = operationalSources({
      orders: new TypeOrmWorkOrderStore(orderSource),
      plans: new InMemoryMaintenancePlanStore(),
      workshops: new InMemoryWorkshopStore(),
      incidents: incidentStore,
      repairs: { linkOfOrder: async () => null },
      ledger: { read: async () => ({ lines: [], links: [], counted: [], totals: [] }) },
      sla: { forIncidents: async () => new Map() },
      assignments: new InMemoryAssignmentStore(),
      vehicleStore: {} as never,
      audit: { list: async () => ({ items: [], total: 0, next: null, from: '', to: '' }) },
      mechanicLinked: async () => linked,
      now: () => NOW,
    });
  }, 900_000);

  afterAll(async () => {
    await Promise.allSettled(open.map((source) => source.destroy()));
    await Promise.allSettled([orders, incidents].map((database) => database?.close()));
  }, 120_000);

  it('reads every order of the company, with costs only for the permission that protects them', async () => {
    const plain = await sources.workOrders(reader(tenantA, ['view']), { withCosts: true });
    expect(plain).toHaveLength(SIZES.orders);
    expect(plain.every((order) => order.costs === undefined)).toBe(true);
    const priced = await sources.workOrders(reader(tenantA, ['view', 'view_costs']), {
      withCosts: true,
    });
    expect(priced).toHaveLength(SIZES.orders);
    expect(priced.some((order) => (order.costs?.length ?? 0) > 0)).toBe(true);
    const one = await sources.workOrders(reader(tenantA, ['view']), {
      vehicleId: 'veh-7',
      withCosts: false,
    });
    expect(one.length).toBeGreaterThan(0);
    expect(one.every((order) => order.vehicleId === 'veh-7')).toBe(true);
  }, 120_000);

  it('pages through every case past draft and filters by vehicle', async () => {
    const all = await sources.incidents(reader(tenantA, ['incidents:view']), {});
    // One case in twenty is a draft in the dataset.
    expect(all).toHaveLength(SIZES.incidents - SIZES.incidents / 20);
    expect(all.some((incident) => incident.status === 'draft')).toBe(false);
    expect(new Set(all.map((incident) => incident.id)).size).toBe(all.length);
    const mine = await sources.incidents(reader(tenantA, ['incidents:view']), {
      vehicleId: 'veh-3',
    });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((incident) => incident.vehicleId === 'veh-3')).toBe(true);
  }, 120_000);

  it("never reads another company's rows and leaves a mechanic-scoped member with nothing", async () => {
    expect(await sources.incidents(reader(randomUUID(), ['incidents:view']), {})).toHaveLength(0);
    expect(
      await sources.workOrders(reader(randomUUID(), ['view']), { withCosts: false }),
    ).toHaveLength(0);
    linked = true;
    try {
      expect(await sources.workOrders(reader(tenantA, ['view']), { withCosts: false })).toEqual([]);
      expect(await sources.incidents(reader(tenantA, ['incidents:view']), {})).toEqual([]);
      expect(await sources.plans(reader(tenantA, ['view']))).toEqual([]);
      expect(
        await sources.workOrders(reader(tenantA, ['view', 'edit']), { withCosts: false }),
      ).toHaveLength(SIZES.orders);
    } finally {
      linked = false;
    }
  }, 120_000);
});
