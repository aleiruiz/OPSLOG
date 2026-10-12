import {
  InMemoryMaintenancePlanStore,
  MaintenancePlanService,
  MaintenancePlanWorker,
  type PlanScanStore,
  type PlanScheduleReader,
} from '../../../../../packages/domain/maintenance/plans/src/index.js';
import {
  InMemoryWorkshopStore,
  WorkshopService,
} from '../../../../../packages/domain/maintenance/workshops/src/index.js';
import {
  InMemoryMechanicStore,
  MechanicService,
} from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import {
  VehicleError,
  type VehicleService,
} from '../../../../../packages/domain/vehicles/src/index.js';
import { MaintenanceApi } from '../../../maintenance/plans/src/index.js';
import { createMechanicScope } from './mechanic-scope.js';
import type { PlatformKernel } from './kernel.js';
import type { PlatformAdapters } from './types.js';

export function buildMaintenanceApis(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  vehicleService: VehicleService,
): {
  readonly maintenance: MaintenanceApi;
  readonly maintenancePlanWorker?: MaintenancePlanWorker;
} {
  const workshopStore = adapters.maintenanceWorkshops ?? new InMemoryWorkshopStore();
  const mechanicStore = adapters.maintenanceMechanics ?? new InMemoryMechanicStore();
  const planStore = adapters.maintenancePlans ?? new InMemoryMaintenancePlanStore();
  const scheduleReader =
    typeof (planStore as Partial<PlanScheduleReader>).readSchedule === 'function' &&
    typeof (planStore as Partial<PlanScheduleReader>).listScheduledOrders === 'function'
      ? (planStore as unknown as PlanScheduleReader)
      : undefined;
  const scanStore = planStore as Partial<PlanScanStore>;
  const maintenancePlanWorker =
    typeof scanStore.scan === 'function' && typeof scanStore.closePreventive === 'function'
      ? new MaintenancePlanWorker(
          planStore,
          scanStore as PlanScanStore,
          {
            read: async (tenantId, vehicleId) => {
              const vehicle = await vehicleService
                .get(tenantId, vehicleId)
                .catch((error: unknown) => {
                  if (error instanceof VehicleError && error.code === 'not_found') return null;
                  throw error;
                });
              if (!vehicle || vehicle.archivedAt !== null) return null;
              return {
                id: vehicle.id,
                odometer: { km: vehicle.odometerKm, updatedAt: vehicle.odometerUpdatedAt },
              };
            },
          },
          kernel.now,
        )
      : undefined;
  const mechanicScope = createMechanicScope(mechanicStore);
  const planService = new MaintenancePlanService(planStore, {
    now: kernel.now,
    ...(scheduleReader ? { scheduleReader } : {}),
    references: {
      vehicleExists: async (tenantId, vehicleId) => {
        const vehicle = await vehicleService.get(tenantId, vehicleId).catch((error: unknown) => {
          if (error instanceof VehicleError && error.code === 'not_found') return null;
          throw error;
        });
        return vehicle !== null && vehicle.archivedAt === null;
      },
      validateAssignments: async (tenantId, workshopId, mechanicId) => {
        const workshop = workshopId ? await workshopStore.get(tenantId, workshopId) : null;
        const mechanic = mechanicId ? await mechanicStore.get(tenantId, mechanicId) : null;
        if ((workshopId && !workshop?.active) || (mechanicId && !mechanic?.active))
          throw new Error('invalid_association');
        if (mechanic && workshopId && mechanic.workshopId !== workshopId)
          throw new Error('invalid_association');
      },
    },
  });
  const workshopService = new WorkshopService(workshopStore, kernel.now);
  const mechanicService = new MechanicService(
    mechanicStore,
    {
      workshops: workshopStore,
      isTenantMember: async (tenantId, memberId) =>
        (await kernel.access.effectiveRole(tenantId, memberId)) !== null,
    },
    kernel.now,
  );
  return {
    maintenance: new MaintenanceApi({
      plans: planService,
      workshops: workshopService,
      mechanics: mechanicService,
      authorize: (token, correlationId, required) =>
        kernel.authorize(token, correlationId, required),
      scope: async (context) => {
        const permissions = await kernel.access.resolvePermissions(context);
        return {
          scoped:
            !permissions.includes('edit') &&
            (await mechanicScope.mechanicLinked(context.tenantId, context.actor.subject)),
        };
      },
    }),
    ...(maintenancePlanWorker ? { maintenancePlanWorker } : {}),
  };
}
