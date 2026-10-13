import { buildIncidentApis } from './incident-children-apis.js';
import type { IncidentServices } from './incident-apis.js';
import type { PlatformKernel } from './kernel.js';
import { buildMaintenanceApis } from './maintenance-apis.js';
import type { PlatformAdapters } from './types.js';
import {
  buildWorkOrderApi,
  withMaintenanceDefaults,
  type WorkOrderFileSupport,
} from './work-order-apis.js';
import type { PiiCipher } from '../../../../../packages/platform/pii/src/index.js';

/** Maintenance, work orders and incidents: the modules that build on the fleet services. */
export function buildDownstreamApis(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  services: IncidentServices,
  pii: PiiCipher,
  files: WorkOrderFileSupport,
) {
  const defaults = withMaintenanceDefaults(adapters);
  return {
    ...buildMaintenanceApis(kernel, defaults, services.vehicles, services.settings),
    workOrders: buildWorkOrderApi(kernel, defaults, services.vehicles, services.settings, files),
    ...buildIncidentApis(kernel, defaults, services, pii, files),
  };
}
