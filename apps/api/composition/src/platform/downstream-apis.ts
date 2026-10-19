import { buildAnalytics, type AnalyticsFleet } from './analytics-apis.js';
import { buildIncidentApis, incidentStores } from './incident-children-apis.js';
import { incidentHoldsVehicle } from './incident-workflow-apis.js';
import type { IncidentServices } from './incident-apis.js';
import type { PlatformKernel } from './kernel.js';
import { buildMaintenanceApis } from './maintenance-apis.js';
import type { PlatformAdapters } from './types.js';
import {
  buildWorkOrderApi,
  withMaintenanceDefaults,
  type WorkOrderFileSupport,
} from './work-order-apis.js';
import type { AreaService } from '../../../../../packages/domain/areas/src/index.js';
import { costPorts, repairOrderReader } from './incident-cost-apis.js';
import { buildAuditQueryApi, buildAuditQueryService } from './audit-query-apis.js';
import { buildSavedViews } from './saved-views-apis.js';
import { buildSearch } from './search-apis.js';
import { buildReports } from './report-apis.js';
import { buildNotifications } from './notification-apis.js';
import { buildWebhooks } from './webhook-apis.js';
import { syntheticAddresses } from './incident-sla-apis.js';
import type { PiiCipher } from '../../../../../packages/platform/pii/src/index.js';

/** Maintenance, work orders and incidents: the modules that build on the fleet services. */
export function buildDownstreamApis(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  services: IncidentServices,
  fleet: AnalyticsFleet,
  pii: PiiCipher,
  files: WorkOrderFileSupport,
  areas: AreaService,
  environment?: string,
  publicOrigin?: string,
) {
  const defaults = withMaintenanceDefaults(adapters);
  const stores = incidentStores(defaults);
  const incidents = buildIncidentApis(kernel, defaults, services, pii, files, stores, environment);
  // The audit screens read the modules through their ports only (descriptions and field histories).
  const auditService = buildAuditQueryService(kernel, adapters.auditRelay, {
    vehicles: services.vehicles,
    employees: services.employees,
    areas,
    incidents: stores.store,
    workOrders: defaults.maintenanceOrders as NonNullable<typeof defaults.maintenanceOrders>,
  });
  const reports = buildReports(kernel, defaults, services, fleet, files.storage, {
    orders: defaults.maintenanceOrders,
    plans: defaults.maintenancePlans,
    workshops: defaults.maintenanceWorkshops as NonNullable<typeof defaults.maintenanceWorkshops>,
    mechanics: defaults.maintenanceMechanics as NonNullable<typeof defaults.maintenanceMechanics>,
    incidents: stores.store,
    repairs: stores.repairs,
    ledger: costPorts(stores.repairs, stores.costs, repairOrderReader(defaults)).ledger,
    sla: incidents.incidentSla.reader,
    audit: auditService,
  });
  const notifications = buildNotifications(kernel, defaults, {
    vehicles: fleet.vehicleStore,
    incidents: stores.store,
    orders: defaults.maintenanceOrders,
    plans: defaults.maintenancePlans,
    mechanics: defaults.maintenanceMechanics as NonNullable<typeof defaults.maintenanceMechanics>,
    sla: incidents.incidentSla,
    exportJobs: reports.store,
    catalog: reports.catalog,
    alerts: fleet.alertService,
    settings: services.settings,
    baseUrl: publicOrigin,
  });
  return {
    auditQuery: buildAuditQueryApi(kernel, auditService),
    ...buildMaintenanceApis(kernel, defaults, services.vehicles, services.settings),
    // Closing an order cannot return the vehicle to `active` while an open case holds it (D11).
    workOrders: buildWorkOrderApi(
      kernel,
      defaults,
      services.vehicles,
      services.settings,
      files,
      // The case that repairs the order through a link does not hold the order's own vehicle.
      async (tenantId, vehicleId, orderId) =>
        incidentHoldsVehicle(
          stores.store,
          tenantId,
          vehicleId,
          (await stores.repairs.linkOfOrder(tenantId, orderId))?.incidentId ?? null,
        ),
    ),
    ...incidents,
    search: buildSearch(kernel, defaults, services, stores.store, pii),
    reports,
    notifications,
    webhooks: buildWebhooks(kernel, defaults, {
      vehicles: fleet.vehicleStore,
      incidents: stores.store,
      orders: defaults.maintenanceOrders,
      employeeStore: fleet.employeeStore,
      employees: services.employees,
      holders: notifications.worker.sources.holders,
      addressOf: (tenantId, actorId) =>
        (defaults.incidentAlertAddresses ?? syntheticAddresses).addressOf(tenantId, actorId),
      mail: notifications.mail,
    }),
    ...buildAnalytics(kernel, {
      areas: fleet.areaService,
      vehicles: fleet.vehicleStore,
      employees: fleet.employeeStore,
      documents: fleet.documentStore,
      policies: services.policies,
      settings: services.settings,
      plans: defaults.maintenancePlans,
      orders: defaults.maintenanceOrders,
      incidents: stores.store,
      sla: incidents.incidentSla.reader,
    }),
    savedViews: buildSavedViews(kernel, defaults),
  };
}
