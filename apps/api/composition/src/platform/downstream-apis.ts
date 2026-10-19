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
import { buildSearch } from './search-apis.js';
import type { PiiCipher } from '../../../../../packages/platform/pii/src/index.js';

/** Maintenance, work orders and incidents: the modules that build on the fleet services. */
export function buildDownstreamApis(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  services: IncidentServices,
  pii: PiiCipher,
  files: WorkOrderFileSupport,
  environment?: string,
) {
  const defaults = withMaintenanceDefaults(adapters);
  const stores = incidentStores(defaults);
  return {
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
    ...buildIncidentApis(kernel, defaults, services, pii, files, stores, environment),
    search: buildSearch(kernel, defaults, services, stores.store, pii),
  };
}
