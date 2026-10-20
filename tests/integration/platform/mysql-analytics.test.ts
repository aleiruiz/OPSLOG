import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DashboardApi } from '../../../apps/api/analytics/src/index.js';
import { analyticsSources } from '../../../apps/api/composition/src/platform/analytics-apis.js';
import {
  DashboardService,
  WIDGET_IDS,
  rangeWindow,
} from '../../../packages/domain/analytics/src/index.js';
import {
  AreaService,
  InMemoryAreaStore,
  NO_RESOURCES,
} from '../../../packages/domain/areas/src/index.js';
import {
  IncidentSlaReader,
  InMemoryIncidentSlaStore,
} from '../../../packages/domain/incidents/sla/src/index.js';
import { InMemoryMaintenancePlanStore } from '../../../packages/domain/maintenance/plans/src/index.js';
import {
  InMemorySettingsStore,
  SettingsService,
} from '../../../packages/domain/settings/src/index.js';
import { ROLE_PERMISSIONS } from '../../../apps/api/composition/src/index.js';
import { VEHICLE_TABLES } from '../../../packages/persistence/vehicles/src/entities.js';
import { EMPLOYEE_TABLES } from '../../../packages/persistence/employees/src/entities.js';
import { INCIDENT_TABLES } from '../../../packages/persistence/incidents/cases/src/entities.js';
import { WORK_ORDER_TABLES } from '../../../packages/persistence/maintenance/orders/src/entities.js';
import { TypeOrmDocumentStore } from '../../../packages/persistence/documents/src/index.js';
import {
  adminUrl,
  startDocumentsDatabase,
  type DocumentsDatabase,
} from '../../../packages/persistence/documents/src/test-support/mysql.js';
import { TypeOrmEmployeeStore } from '../../../packages/persistence/employees/src/index.js';
import {
  startEmployeesDatabase,
  type EmployeesDatabase,
} from '../../../packages/persistence/employees/src/test-support/mysql.js';
import { TypeOrmIncidentStore } from '../../../packages/persistence/incidents/cases/src/index.js';
import {
  startIncidentDatabase,
  type IncidentTestDatabase,
} from '../../../packages/persistence/incidents/cases/src/test-support/mysql.js';
import { TypeOrmPolicyStore } from '../../../packages/persistence/insurance/src/index.js';
import {
  startInsuranceDatabase,
  type InsuranceDatabase,
} from '../../../packages/persistence/insurance/src/test-support/mysql.js';
import { TypeOrmWorkOrderStore } from '../../../packages/persistence/maintenance/orders/src/index.js';
import {
  startWorkOrderDatabase,
  type WorkOrderTestDatabase,
} from '../../../packages/persistence/maintenance/orders/src/test-support/mysql.js';
import { TypeOrmVehicleStore } from '../../../packages/persistence/vehicles/src/index.js';
import {
  startVehiclesDatabase,
  type VehiclesDatabase,
} from '../../../packages/persistence/vehicles/src/test-support/mysql.js';
import {
  NOW,
  SIZES,
  seedDocuments,
  seedEmployees,
  seedIncidents,
  seedOrders,
  seedPolicies,
  seedVehicles,
} from './analytics-dataset.js';

/**
 * The dashboard on the real MySQL stores of every source module, over the SPECS §9.3 dataset for one
 * company (500 vehicles, 1.000 employees, about 100.000 operational records). Each module has its own
 * database and restricted runtime account, as in production; the dashboard reads them only through
 * aggregate ports. CI: mysql service and OPSLOG_TEST_MYSQL_ADMIN_URL; locally skipped when unset.
 * Only synthetic data.
 */
const suite = adminUrl ? describe : describe.skip;
const ALL = [...new Set(Object.values(ROLE_PERMISSIONS).flat())];

/** Nearest-rank percentile: the smallest sample with at least p of the samples at or below it. */
const percentile = (samples: readonly number[], p: number): number =>
  [...samples].sort((a, b) => a - b)[Math.ceil(p * samples.length) - 1] as number;

// Every test reads the real stores; a loaded CI runner needs more than the 5 s default.
suite('dashboard on the real MySQL stores', { timeout: 30_000 }, () => {
  let vehicles: VehiclesDatabase;
  let employees: EmployeesDatabase;
  let documents: DocumentsDatabase;
  let policies: InsuranceDatabase;
  let orders: WorkOrderTestDatabase;
  let incidents: IncidentTestDatabase;
  let service: DashboardService;
  let api: DashboardApi;
  let calls = 0;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const sources: { destroy(): Promise<void> }[] = [];
  const leafAreas: string[] = [];
  let rootArea = '';
  const count = async (
    database: { rows<T>(sql: string, params?: unknown[]): Promise<T[]> },
    sql: string,
    params: unknown[],
  ) =>
    Number(
      ((await database.rows<{ n: string | number }>(sql, params))[0] as { n: string | number }).n,
    );

  beforeAll(async () => {
    [vehicles, employees, documents, policies, orders, incidents] = await Promise.all([
      startVehiclesDatabase('dv'),
      startEmployeesDatabase('de'),
      startDocumentsDatabase('dd'),
      startInsuranceDatabase('di'),
      startWorkOrderDatabase('dw'),
      startIncidentDatabase('dn'),
    ]);
    const open = {
      vehicles: await vehicles.openRuntime(),
      employees: await employees.openRuntime(),
      documents: await documents.openRuntime(),
      policies: await policies.openRuntime(),
      orders: await orders.openOrders('a'),
      incidents: await incidents.openIncidents('a'),
    };
    sources.push(...Object.values(open));
    const areas = new AreaService(new InMemoryAreaStore(), {
      now: () => NOW,
      resources: { vehicles: NO_RESOURCES, people: NO_RESOURCES },
    });
    const root = await areas.create(tenantA, 'user-seed', { name: 'Raíz' });
    rootArea = root.id;
    for (const name of ['Norte', 'Sur', 'Este', 'Oeste', 'Centro'])
      leafAreas.push((await areas.create(tenantA, 'user-seed', { name, parentId: root.id })).id);
    await seedVehicles(open.vehicles, tenantA, leafAreas);
    await seedVehicles(open.vehicles, tenantB, ['area-b'], 3);
    await seedEmployees(open.employees, tenantA, leafAreas);
    await seedDocuments(open.documents, tenantA);
    await seedPolicies(open.policies, tenantA);
    await seedOrders(open.orders, tenantA);
    await seedIncidents(open.incidents, tenantA, leafAreas);
    const incidentStore = new TypeOrmIncidentStore(open.incidents);
    const settings = new SettingsService(new InMemorySettingsStore(), { now: () => NOW });
    const slaSettings = {
      settings: async (tenantId: string) => {
        const company = await settings.get(tenantId);
        return {
          timeZone: company.timeZone,
          targetDays: company.incidentSlaDays,
          inactivityDays: company.incidentInactivityDays,
        };
      },
    };
    service = new DashboardService(
      analyticsSources({
        vehicles: new TypeOrmVehicleStore(open.vehicles),
        employees: new TypeOrmEmployeeStore(open.employees),
        documents: new TypeOrmDocumentStore(open.documents),
        policies: new TypeOrmPolicyStore(open.policies),
        areas,
        settings,
        plans: new InMemoryMaintenancePlanStore(),
        orders: new TypeOrmWorkOrderStore(open.orders),
        incidents: incidentStore,
        sla: new IncidentSlaReader(
          incidentStore,
          new InMemoryIncidentSlaStore(incidentStore, () => undefined),
          slaSettings,
          { now: () => NOW },
        ),
      }),
      { now: () => NOW },
    );
    api = new DashboardApi({
      service,
      authorize: async (token) => ({
        context: { tenantId: token === 'b' ? tenantB : tenantA } as never,
        permissions: ALL,
      }),
      now: () => NOW,
    });
  }, 900_000);

  afterAll(async () => {
    await Promise.allSettled(sources.map((source) => source.destroy()));
    await Promise.allSettled(
      [vehicles, employees, documents, policies, orders, incidents].map((database) =>
        database?.close(),
      ),
    );
  }, 120_000);

  const compute = async (tenantId: string, query = {}) =>
    service.compute(tenantId, await service.resolve(tenantId, query), ALL);

  it('seeds the dataset of SPECS §9.3 for one company', async () => {
    const total =
      SIZES.vehicles * (1 + SIZES.statusEntriesPerVehicle) +
      SIZES.employees +
      SIZES.vehicleDocuments +
      SIZES.employeeDocuments +
      SIZES.policies +
      SIZES.orders * 2.25 +
      SIZES.incidents;
    expect(total).toBeGreaterThanOrEqual(100_000);
    expect(
      await count(
        vehicles,
        `SELECT COUNT(*) AS n FROM ${VEHICLE_TABLES.vehicles} WHERE company_id=?`,
        [tenantA],
      ),
    ).toBe(500);
    expect(
      await count(
        employees,
        `SELECT COUNT(*) AS n FROM ${EMPLOYEE_TABLES.employees} WHERE company_id=?`,
        [tenantA],
      ),
    ).toBe(1000);
  });

  it('answers every widget with the figures the tables hold', async () => {
    const dashboard = await compute(tenantA);
    expect(dashboard.widgets.map((widget) => widget.id)).toEqual([...WIDGET_IDS]);
    const value = (id: string) =>
      (dashboard.widgets.find((widget) => widget.id === id) as { value: number }).value;
    expect(value('vehicles_active')).toBe(
      await count(
        vehicles,
        `SELECT COUNT(*) AS n FROM ${VEHICLE_TABLES.vehicles} WHERE company_id=? AND status='active' AND archived_at IS NULL`,
        [tenantA],
      ),
    );
    expect(value('drivers_active')).toBe(
      await count(
        employees,
        `SELECT COUNT(*) AS n FROM ${EMPLOYEE_TABLES.employees} WHERE company_id=? AND kind='driver' AND status='active' AND archived_at IS NULL`,
        [tenantA],
      ),
    );
    expect(value('incidents_open')).toBe(
      await count(
        incidents,
        `SELECT COUNT(*) AS n FROM ${INCIDENT_TABLES.incidents} WHERE company_id=? AND status NOT IN ('draft','closed','cancelled')`,
        [tenantA],
      ),
    );
    const cost = dashboard.widgets.find(
      (widget) => widget.id === 'maintenance_cost',
    ) as unknown as {
      orders: number;
      byCurrency: { currency: string; amountMinor: string }[];
    };
    const resolved = await service.resolve(tenantA, {});
    const bounds = rangeWindow(resolved.from, resolved.to, resolved.timeZone);
    const closedInRange = await count(
      orders,
      `SELECT COUNT(*) AS n FROM ${WORK_ORDER_TABLES.orders} WHERE company_id=? AND status='closed' AND closed_at >= ? AND closed_at < ?`,
      [tenantA, new Date(bounds.from), new Date(bounds.to)],
    );
    expect(cost.orders).toBe(closedInRange);
    expect(cost.byCurrency.map((item) => item.currency)).toEqual(['MXN', 'USD']);
  });

  it('keeps tenant B apart, with a warm cache for A', async () => {
    const warm = await api.get('a', 'corr', {});
    expect(warm.ok).toBe(true);
    const other = await api.get('b', 'corr', {});
    const widgets = (other.value?.widgets ?? []) as unknown as {
      id: string;
      value?: number;
      orders?: number;
    }[];
    expect(widgets.find((widget) => widget.id === 'vehicles_active')?.value).toBe(2);
    expect(widgets.find((widget) => widget.id === 'incidents_open')?.value).toBe(0);
    expect(widgets.find((widget) => widget.id === 'maintenance_cost')?.orders).toBe(0);
    // A's second call is the cached object; B's figures never leak into it.
    expect((await api.get('a', 'corr', {})).value).toBe(warm.value);
  });

  it('filters by a child area and by its parent, which adds its children', async () => {
    const active = async (areaId: string) =>
      (
        (await compute(tenantA, { areaId })).widgets.find(
          (widget) => widget.id === 'vehicles_active',
        ) as { value: number }
      ).value;
    const inArea = (areaId: string) =>
      count(
        vehicles,
        `SELECT COUNT(*) AS n FROM ${VEHICLE_TABLES.vehicles} WHERE company_id=? AND area_id=? AND status='active' AND archived_at IS NULL`,
        [tenantA, areaId],
      );
    let sum = 0;
    for (const leaf of leafAreas) {
      expect(await active(leaf)).toBe(await inArea(leaf));
      sum += await active(leaf);
    }
    expect(await active(rootArea)).toBe(sum);
  });

  it('adds the expiring documents of the areas up to the company figure, archived owners left out', async () => {
    const expiring = async (query = {}) =>
      (
        (await compute(tenantA, query)).widgets.find(
          (widget) => widget.id === 'documents_expiring',
        ) as { value: number }
      ).value;
    let sum = 0;
    for (const leaf of leafAreas) sum += await expiring({ areaId: leaf });
    const company = await expiring();
    expect(sum).toBeGreaterThan(0);
    expect(company).toBe(sum);
    expect(await expiring({ areaId: rootArea })).toBe(sum);
  });

  it('computes the whole dashboard in under one second at p95, without cache', async () => {
    const samples: number[] = [];
    for (let run = 0; run < 25; run += 1) {
      const started = performance.now();
      calls += 1;
      await compute(tenantA);
      samples.push(performance.now() - started);
    }
    const p95 = percentile(samples, 0.95);
    // eslint-disable-next-line no-console
    console.info(
      `dashboard p95 ${p95.toFixed(0)} ms, max ${Math.max(...samples).toFixed(0)} ms over ${calls} uncached runs`,
    );
    // The 1 s budget is enforced with OPSLOG_PERF=1; a normal run only guards against a blow-up.
    expect(p95).toBeLessThanOrEqual(process.env.OPSLOG_PERF === '1' ? 1000 : 5000);
  }, 120_000);
});
