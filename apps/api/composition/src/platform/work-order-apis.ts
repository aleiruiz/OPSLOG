import {
  InMemoryWorkOrderStore,
  WorkOrderService,
  type WorkOrderReferences,
} from '../../../../../packages/domain/maintenance/orders/src/index.js';
import {
  InMemoryMaintenancePlanStore,
  type PlanScanStore,
  type PlanScheduleReader,
} from '../../../../../packages/domain/maintenance/plans/src/index.js';
import { InMemoryWorkshopStore } from '../../../../../packages/domain/maintenance/workshops/src/index.js';
import { InMemoryMechanicStore } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import {
  VehicleError,
  type VehicleService,
} from '../../../../../packages/domain/vehicles/src/index.js';
import { WorkOrderApi } from '../../../maintenance/orders/src/index.js';
import { createMechanicScope } from './mechanic-scope.js';
import type { PlatformKernel } from './kernel.js';
import type { PlatformAdapters } from './types.js';

const idOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** One set of maintenance stores shared by the plans and work order APIs (in-memory by default). */
export function withMaintenanceDefaults(adapters: PlatformAdapters): PlatformAdapters {
  return {
    ...adapters,
    maintenancePlans: adapters.maintenancePlans ?? new InMemoryMaintenancePlanStore(),
    maintenanceWorkshops: adapters.maintenanceWorkshops ?? new InMemoryWorkshopStore(),
    maintenanceMechanics: adapters.maintenanceMechanics ?? new InMemoryMechanicStore(),
    maintenanceOrders: adapters.maintenanceOrders ?? new InMemoryWorkOrderStore(),
  };
}

/**
 * Work orders (MNT-ORDERS) over the MNT-PLANS read ports. Preventive orders are read through the
 * plans schedule reader; closures reach the plans worker only through the durable outbox event.
 */
export function buildWorkOrderApi(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  vehicleService: VehicleService,
): WorkOrderApi {
  const store = adapters.maintenanceOrders ?? new InMemoryWorkOrderStore();
  const workshops = adapters.maintenanceWorkshops ?? new InMemoryWorkshopStore();
  const mechanics = adapters.maintenanceMechanics ?? new InMemoryMechanicStore();
  const plans = adapters.maintenancePlans ?? new InMemoryMaintenancePlanStore();
  const schedule = plans as Partial<PlanScheduleReader>;
  const scope = createMechanicScope(mechanics);
  const { mechanicIdsOfMember } = scope;
  const refs: WorkOrderReferences = {
    vehicleExists: async (tenantId, vehicleId) => {
      const vehicle = await vehicleService.get(tenantId, vehicleId).catch((error: unknown) => {
        if (error instanceof VehicleError && error.code === 'not_found') return null;
        throw error;
      });
      return vehicle !== null && vehicle.archivedAt === null;
    },
    isTenantMember: async (tenantId, memberId) =>
      (await kernel.access.effectiveRole(tenantId, memberId)) !== null,
    workshop: (tenantId, id) => workshops.get(tenantId, id),
    mechanic: (tenantId, id) => mechanics.get(tenantId, id),
    mechanicIdsOfMember,
    scheduledOrder: async (tenantId, planId, orderId) => {
      if (typeof schedule.listScheduledOrders !== 'function') return null;
      const found = (await schedule.listScheduledOrders.call(plans, tenantId, planId)).find(
        (order) => order.id === orderId,
      );
      return found
        ? {
            id: found.id,
            occurrenceId: found.occurrenceId,
            planId: found.planId,
            vehicleId: found.vehicleId,
            status: found.status,
            workshopId: idOrNull(found.snapshot['workshopId']),
            mechanicId: idOrNull(found.snapshot['mechanicId']),
          }
        : null;
    },
    planBaseline: async (tenantId, planId, occurrenceId) => {
      const scans = plans as Partial<PlanScanStore>;
      if (occurrenceId !== null && typeof scans.baselineBeforeClosure === 'function')
        return scans.baselineBeforeClosure.call(plans, tenantId, planId, occurrenceId);
      const plan = await plans.get(tenantId, planId);
      return plan
        ? {
            lastServiceDate: plan.lastServiceDate ?? null,
            lastServiceKm: plan.lastServiceKm ?? null,
          }
        : null;
    },
    // SPECS D20: company settings have no costly-closure threshold yet, so none is configured.
    closeApprovalRequired: async () => false,
  };
  return new WorkOrderApi({
    orders: new WorkOrderService(store, refs, { now: kernel.now }),
    authorize: async (token, correlationId) => {
      const context = await kernel.authorize(token, correlationId, ['view']);
      return { context, permissions: await kernel.access.resolvePermissions(context) };
    },
    mechanicIdsOfMember,
    mechanicLinked: scope.mechanicLinked,
  });
}
