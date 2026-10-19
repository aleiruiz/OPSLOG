import type { Permission } from '../../identity/src/index.js';
import { addDays, dayEnd } from './calendar.js';
import { drilldownOf, visibleWidgets } from './catalog.js';
import {
  activeVehicleIds,
  documentCoverage,
  ownerScope,
  REQUIRED_TYPES,
  upcomingPlans,
} from './compliance-widgets.js';
import {
  availability,
  countActive,
  countActiveDrivers,
  countOutOfService,
  evaluatedDays,
} from './fleet-widgets.js';
import {
  criticalCount,
  monthlyIncidents,
  rangeWindow,
  resolutionTime,
} from './incident-widgets.js';
import { costByCurrency, maintenanceOnTime } from './maintenance-widgets.js';
import type {
  AnalyticsSources,
  ClosedOrderFact,
  EmployeeFact,
  IncidentTimelineFact,
  OpenCaseFact,
  PlanFact,
  RequiredDocumentFact,
  StatusEntryFact,
  VehicleFact,
} from './ports.js';
import { resolveQuery } from './query.js';
import { percentOf } from './stats.js';
import {
  AnalyticsError,
  type Dashboard,
  type DashboardQuery,
  type DashboardWidget,
  type ResolvedQuery,
  type WidgetDefinition,
  type WidgetId,
} from './types.js';

export interface DashboardServiceOptions {
  readonly now?: () => Date;
}

/** Everything the formulas read, fetched once per request and only for the widgets the reader may see. */
interface Facts {
  vehicles: readonly VehicleFact[];
  employees: readonly EmployeeFact[];
  entries: readonly StatusEntryFact[];
  plans: readonly PlanFact[];
  documentsExpiring: number;
  validDocuments: readonly RequiredDocumentFact[];
  insuranceExpiring: number;
  covered: readonly string[];
  orders: readonly ClosedOrderFact[];
  openCases: readonly OpenCaseFact[];
  timeline: readonly IncidentTimelineFact[];
}

/**
 * The dashboard of Inicio (FR-140, FR-141): every indicator of the catalog computed from the aggregate
 * read ports, for the widgets the reader's permissions allow and no others. A widget without
 * permission is not computed, so neither its figure nor its name leaves the service.
 */
export class DashboardService {
  private readonly now: () => Date;

  public constructor(
    private readonly sources: AnalyticsSources,
    options: DashboardServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** Validates the request and fills its defaults in the company's zone. */
  public async resolve(tenantId: string, query: DashboardQuery): Promise<ResolvedQuery> {
    return resolveQuery(query, await this.sources.company(tenantId), this.now());
  }

  public async compute(
    tenantId: string,
    query: ResolvedQuery,
    granted: readonly Permission[],
  ): Promise<Dashboard> {
    const visible = visibleWidgets(granted);
    const ids = new Set<WidgetId>(visible.map((definition) => definition.id));
    const areaIds = await this.areas(tenantId, query.areaId);
    const facts = await this.read(tenantId, query, ids, areaIds);
    return {
      asOf: this.now().toISOString(),
      timeZone: query.timeZone,
      today: query.today,
      range: { from: query.from, to: query.to },
      areaId: query.areaId,
      expiryWindowDays: query.expiryWindowDays,
      widgets: visible.map((definition) => this.widget(definition, query, facts)),
    };
  }

  private async areas(tenantId: string, areaId: string | null): Promise<readonly string[] | null> {
    if (areaId === null) return null;
    const subtree = await this.sources.areaSubtree(tenantId, areaId);
    if (subtree === null) throw new AnalyticsError('invalid_area', 'area_id');
    return subtree;
  }

  private async read(
    tenantId: string,
    query: ResolvedQuery,
    ids: ReadonlySet<WidgetId>,
    areaIds: readonly string[] | null,
  ): Promise<Facts> {
    const want = (...wanted: WidgetId[]): boolean => wanted.some((id) => ids.has(id));
    const window = rangeWindow(query.from, query.to, query.timeZone);
    const { sources } = this;
    const days = evaluatedDays(query.from, query.to, query.today);
    const [vehicles, employees] = await Promise.all([
      want(
        'vehicles_active',
        'vehicles_out_of_service',
        'maintenance_upcoming',
        'documents_expiring',
        'insurance_expiring',
        'availability',
        'documents_valid_pct',
        'insurance_valid_pct',
        'maintenance_on_time',
        'maintenance_cost',
      )
        ? sources.fleet.vehicles(tenantId, areaIds, window.from)
        : [],
      want('drivers_active', 'documents_expiring', 'documents_valid_pct')
        ? sources.fleet.employees(tenantId, areaIds)
        : [],
    ]);
    const scope = ownerScope(areaIds, vehicles, employees);
    const until = new Date(dayEnd(days[days.length - 1] ?? query.from, query.timeZone));
    const expiring = {
      from: query.today,
      until: addDays(query.today, query.expiryWindowDays),
    };
    const vehicleScope = areaIds === null ? null : (scope?.vehicle ?? []);
    const [
      entries,
      plans,
      documentsExpiring,
      validDocuments,
      insuranceExpiring,
      covered,
      orders,
      openCases,
      timeline,
    ] = await Promise.all([
      want('availability') && days.length > 0
        ? sources.fleet.statusEntries(
            tenantId,
            vehicles.map((vehicle) => vehicle.id),
            until.toISOString(),
          )
        : [],
      want('maintenance_upcoming') ? sources.maintenance.plans(tenantId) : [],
      want('documents_expiring') ? sources.documents.countExpiring(tenantId, expiring, scope) : 0,
      want('documents_valid_pct')
        ? sources.documents.validRequired(tenantId, query.today, REQUIRED_TYPES)
        : [],
      want('insurance_expiring')
        ? sources.insurance.countExpiring(tenantId, expiring, vehicleScope)
        : 0,
      want('insurance_valid_pct')
        ? sources.insurance.coveredVehicleIds(tenantId, query.today, activeVehicleIds(vehicles))
        : [],
      want('maintenance_on_time', 'maintenance_cost')
        ? sources.maintenance.closedOrders(tenantId, window)
        : [],
      want('incidents_open', 'incidents_critical')
        ? sources.incidents.openCases(tenantId, areaIds)
        : [],
      want('incidents_monthly', 'incidents_resolution_time')
        ? sources.incidents.timeline(tenantId, areaIds, window)
        : [],
    ]);
    // An order belongs to the area its vehicle sits in (archived vehicles included).
    const inArea = new Set(vehicles.map((vehicle) => vehicle.id));
    return {
      vehicles,
      employees,
      entries,
      plans,
      documentsExpiring,
      validDocuments,
      insuranceExpiring,
      covered,
      orders: areaIds === null ? orders : orders.filter((order) => inArea.has(order.vehicleId)),
      openCases,
      timeline,
    };
  }

  private widget(
    definition: WidgetDefinition,
    query: ResolvedQuery,
    facts: Facts,
  ): DashboardWidget {
    const base = {
      id: definition.id,
      scope: definition.scope,
      definition: {
        formula: definition.formula,
        numerator: definition.numerator,
        denominator: definition.denominator,
      },
      drilldown: drilldownOf(definition.id, query),
    };
    const window = rangeWindow(query.from, query.to, query.timeZone);
    switch (definition.id) {
      case 'vehicles_active':
        return { ...base, kind: 'count', value: countActive(facts.vehicles) };
      case 'vehicles_out_of_service':
        return { ...base, kind: 'count', value: countOutOfService(facts.vehicles) };
      case 'drivers_active':
        return { ...base, kind: 'count', value: countActiveDrivers(facts.employees) };
      case 'maintenance_upcoming':
        return {
          ...base,
          kind: 'count',
          value: upcomingPlans(facts.plans, facts.vehicles, query.today),
        };
      case 'documents_expiring':
        return { ...base, kind: 'count', value: facts.documentsExpiring };
      case 'insurance_expiring':
        return { ...base, kind: 'count', value: facts.insuranceExpiring };
      case 'incidents_open':
        return { ...base, kind: 'count', value: facts.openCases.length };
      case 'incidents_critical':
        return { ...base, kind: 'count', value: criticalCount(facts.openCases) };
      case 'availability':
        return {
          ...base,
          kind: 'availability',
          ...availability(
            facts.vehicles,
            facts.entries,
            evaluatedDays(query.from, query.to, query.today),
            query.timeZone,
          ),
        };
      case 'documents_valid_pct': {
        const { numerator, denominator, percent, parts } = documentCoverage(
          facts.vehicles,
          facts.employees,
          facts.validDocuments,
        );
        return { ...base, kind: 'ratio', numerator, denominator, percent, parts, excluded: 0 };
      }
      case 'insurance_valid_pct': {
        const active = activeVehicleIds(facts.vehicles);
        const covered = new Set(facts.covered);
        const numerator = active.filter((id) => covered.has(id)).length;
        return {
          ...base,
          kind: 'ratio',
          numerator,
          denominator: active.length,
          percent: percentOf(numerator, active.length),
          parts: [],
          excluded: 0,
        };
      }
      case 'maintenance_on_time':
        return { ...base, kind: 'ratio', parts: [], ...maintenanceOnTime(facts.orders) };
      case 'incidents_monthly':
        return {
          ...base,
          kind: 'monthly',
          ...monthlyIncidents(facts.timeline, query, window, query.timeZone),
        };
      case 'incidents_resolution_time':
        return { ...base, kind: 'duration', ...resolutionTime(facts.timeline, window) };
      case 'maintenance_cost':
        return {
          ...base,
          kind: 'money',
          orders: facts.orders.length,
          byCurrency: costByCurrency(facts.orders),
        };
    }
  }
}
