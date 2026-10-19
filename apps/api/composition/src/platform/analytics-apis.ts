import type { AlertService } from '../../../../../packages/domain/alerts/src/index.js';
import type { AreaService } from '../../../../../packages/domain/areas/src/index.js';
import { MAX_LIST_LIMIT } from '../../../../../packages/domain/areas/src/index.js';
import {
  DashboardService,
  type AnalyticsSources,
} from '../../../../../packages/domain/analytics/src/index.js';
import type {
  DocumentAnalyticsReads,
  DocumentStore,
} from '../../../../../packages/domain/documents/src/index.js';
import type {
  EmployeeAnalyticsReads,
  EmployeeStore,
} from '../../../../../packages/domain/employees/src/index.js';
import type {
  PolicyAnalyticsReads,
  PolicyStore,
} from '../../../../../packages/domain/insurance/src/index.js';
import type {
  IncidentAnalyticsReads,
  IncidentStore,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import type { IncidentSlaReader } from '../../../../../packages/domain/incidents/sla/src/index.js';
import type { PlanStore } from '../../../../../packages/domain/maintenance/plans/src/index.js';
import { targets } from '../../../../../packages/domain/maintenance/plans/src/index.js';
import type {
  WorkOrderAnalyticsReads,
  WorkOrderStore,
} from '../../../../../packages/domain/maintenance/orders/src/index.js';
import type { SettingsService } from '../../../../../packages/domain/settings/src/index.js';
import type {
  VehicleAnalyticsReads,
  VehicleStore,
} from '../../../../../packages/domain/vehicles/src/index.js';
import { DashboardApi } from '../../../analytics/src/index.js';
import type { PlatformKernel } from './kernel.js';
import type { ReportsModule } from './report-apis.js';

/** The fleet stores and the area service as `buildDomainApis` holds them. */
export interface AnalyticsFleet {
  /** Document, policy and licence alerts: the alerts screen and the notification scan read the same service. */
  readonly alertService: AlertService;
  readonly areaService: AreaService;
  readonly vehicleStore: VehicleStore;
  readonly employeeStore: EmployeeStore;
  readonly documentStore: DocumentStore;
}

/** What `GET /api/v1/dashboard` adds to the platform. */
export interface AnalyticsApis {
  readonly dashboard: DashboardApi;
}

/** What the reports and their exports add to the platform. */
export interface ReportApis {
  readonly reports: ReportsModule;
}

/** The stores and services the dashboard reads; each module answers with aggregates only. */
export interface AnalyticsInputs {
  readonly vehicles: VehicleStore;
  readonly employees: EmployeeStore;
  readonly documents: DocumentStore;
  readonly policies: PolicyStore;
  readonly areas: AreaService;
  readonly settings: SettingsService;
  readonly plans: PlanStore;
  readonly orders: WorkOrderStore;
  readonly incidents: IncidentStore;
  readonly sla: IncidentSlaReader;
}

/**
 * A store that does not provide its aggregate reads cannot feed the dashboard. The module stores of
 * this repository (memory and MySQL) all do; an injected one that does not fails loudly.
 */
function reads<T extends object>(store: object, method: keyof T & string, module: string): T {
  if (typeof (store as Record<string, unknown>)[method] !== 'function')
    throw new Error(`The ${module} store does not provide the dashboard reads (${method})`);
  return store as T;
}

/** The area and all its descendants, from the tree of the company; null when it is not one of its areas. */
async function subtree(
  areas: AreaService,
  tenantId: string,
  areaId: string,
): Promise<readonly string[] | null> {
  const children = new Map<string | null, string[]>();
  const known = new Set<string>();
  for (let offset = 0, total = 1; offset < total; offset += MAX_LIST_LIMIT) {
    const slice = await areas.list(tenantId, {
      includeInactive: true,
      limit: MAX_LIST_LIMIT,
      offset,
    });
    total = slice.total;
    for (const area of slice.items) {
      known.add(area.id);
      children.set(area.parentId, [...(children.get(area.parentId) ?? []), area.id]);
    }
    if (slice.items.length === 0) break;
  }
  if (!known.has(areaId)) return null;
  const result = [areaId];
  for (const id of result) result.push(...(children.get(id) ?? []));
  return result;
}

/** The read ports of the dashboard over the module stores. Nothing here returns a name, a number or a note. */
export function analyticsSources(inputs: AnalyticsInputs): AnalyticsSources {
  const vehicles = (): VehicleAnalyticsReads =>
    reads(inputs.vehicles, 'analyticsVehicles', 'vehicles');
  const employees = (): EmployeeAnalyticsReads =>
    reads(inputs.employees, 'analyticsEmployees', 'employees');
  const documents = (): DocumentAnalyticsReads =>
    reads(inputs.documents, 'analyticsCountExpiring', 'documents');
  const policies = (): PolicyAnalyticsReads =>
    reads(inputs.policies, 'analyticsCountExpiring', 'insurance');
  const orders = (): WorkOrderAnalyticsReads => reads(inputs.orders, 'closedFacts', 'work orders');
  const incidents = (): IncidentAnalyticsReads =>
    reads(inputs.incidents, 'analyticsOpenCases', 'incidents');
  return {
    company: async (tenantId) => {
      const settings = await inputs.settings.get(tenantId);
      return { timeZone: settings.timeZone, expiryWindowDays: settings.expiryWindowDays };
    },
    areaSubtree: (tenantId, areaId) => subtree(inputs.areas, tenantId, areaId),
    fleet: {
      vehicles: (tenantId, areaIds, since) =>
        vehicles().analyticsVehicles(tenantId, areaIds, since),
      statusEntries: (tenantId, ids, until) =>
        vehicles().analyticsStatusChanges(tenantId, ids, until),
      employees: (tenantId, areaIds) => employees().analyticsEmployees(tenantId, areaIds),
    },
    documents: {
      countExpiring: (tenantId, window, scope) =>
        documents().analyticsCountExpiring(tenantId, window, scope),
      validRequired: (tenantId, today, types) =>
        documents().analyticsValidRequired(tenantId, today, types),
    },
    insurance: {
      countExpiring: (tenantId, window, ids) =>
        policies().analyticsCountExpiring(tenantId, window, ids),
      coveredVehicleIds: (tenantId, day, ids) =>
        policies().analyticsCoveredVehicleIds(tenantId, day, ids),
    },
    maintenance: {
      plans: async (tenantId) =>
        (await inputs.plans.list(tenantId))
          .filter((plan) => plan.state === 'active')
          .map((plan) => ({ vehicleId: plan.vehicleId, ...targets(plan) })),
      closedOrders: (tenantId, window) => orders().closedFacts(tenantId, window),
    },
    incidents: {
      openCases: async (tenantId, areaIds) => {
        const open = await incidents().analyticsOpenCases(tenantId, areaIds);
        const views = await inputs.sla.forIncidents(tenantId, open);
        return open.map((incident) => ({
          severity: incident.severity,
          slaBreached: views.get(incident.id)?.state === 'breached',
        }));
      },
      timeline: (tenantId, areaIds, window) =>
        incidents().analyticsTimeline(tenantId, areaIds, window),
    },
  };
}

/** `GET /api/v1/dashboard` over the module stores, with the 5-minute cache of the API layer. */
export function buildAnalytics(kernel: PlatformKernel, inputs: AnalyticsInputs): AnalyticsApis {
  return {
    dashboard: new DashboardApi({
      service: new DashboardService(analyticsSources(inputs), { now: kernel.now }),
      authorize: async (token, correlationId) => {
        const context = await kernel.authorize(token, correlationId, []);
        return { context, permissions: await kernel.access.resolvePermissions(context) };
      },
      now: kernel.now,
    }),
  };
}
