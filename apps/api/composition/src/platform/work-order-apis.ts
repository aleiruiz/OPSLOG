import {
  InMemoryWorkOrderStore,
  WorkOrderError,
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
import {
  FileError,
  type FileErrorCode,
  type FileRecordStore,
} from '../../../../../packages/domain/files/src/index.js';
import type { SettingsService } from '../../../../../packages/domain/settings/src/index.js';
import type { FilePipeline } from '../../../../../packages/platform/files/src/index.js';
import type { FilesApi } from '../../../files/src/index.js';
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

/** A file that cannot be served maps to the closest work order error; nothing of the file module leaks. */
const fileFailure = (code: string | undefined): WorkOrderError =>
  new WorkOrderError(
    code === 'not_found'
      ? 'not_found'
      : code === 'not_available'
        ? 'invalid_transition'
        : 'invalid_input',
  );

/** Upload failures that are the caller's input (type, content or size), not a server fault. */
export const UPLOAD_REJECTIONS: ReadonlySet<FileErrorCode> = new Set<FileErrorCode>([
  'invalid_input',
  'unsupported_type',
  'type_mismatch',
  'too_large',
]);

/** The files module as the work orders use it: uploads go through its pipeline, downloads through its grants. */
export interface WorkOrderFileSupport {
  readonly records: FileRecordStore;
  readonly pipeline: FilePipeline;
  readonly files: FilesApi;
}

/**
 * Work orders (MNT-ORDERS) over the MNT-PLANS read ports. Preventive orders are read through the
 * plans schedule reader; closures reach the plans worker only through the durable outbox event.
 */
export function buildWorkOrderApi(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  vehicleService: VehicleService,
  settings: SettingsService,
  files: WorkOrderFileSupport,
  vehicleBlocks?: WorkOrderReferences['vehicleBlocks'],
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
    // SPECS D20: when the company configured a costly-closure threshold every closure needs a prior
    // supervisor approval, whatever the final cost; with none configured nothing is asked.
    closeApprovalRequired: async (tenantId) =>
      (await settings.get(tenantId)).closeCostThreshold !== null,
    ...(vehicleBlocks ? { vehicleBlocks } : {}),
    // SPECS:184: calendar dates follow the company's IANA zone.
    timeZone: async (tenantId) => (await settings.get(tenantId)).timeZone,
    fileRequirements: async (tenantId) => {
      const required = (await settings.get(tenantId)).maintenanceEvidence;
      return { evidence: required !== 'none', invoice: required === 'evidence_invoice' };
    },
    fileRecord: async (tenantId, fileId) => {
      const record = await files.records.get(tenantId, fileId);
      return record
        ? {
            id: record.id,
            status: record.status,
            kind: record.kind,
            sensitivity: record.sensitivity,
            createdBy: record.createdBy,
            displayName: record.displayName,
            contentType: record.contentType,
            sizeBytes: record.sizeBytes,
          }
        : null;
    },
  };
  return new WorkOrderApi({
    orders: new WorkOrderService(store, refs, { now: kernel.now }),
    authorize: async (token, correlationId) => {
      const context = await kernel.authorize(token, correlationId, ['view']);
      return { context, permissions: await kernel.access.resolvePermissions(context) };
    },
    mechanicIdsOfMember,
    mechanicLinked: scope.mechanicLinked,
    files: {
      // The actor was authorized for this exact order change before any byte is stored; the file
      // is owned by that actor and only a later link makes it evidence.
      ingest: async (tenantId, actorId, correlationId, input) => {
        try {
          const record = await files.pipeline.ingestOriginal(
            { tenantId, actorId, actorKind: 'user', correlationId },
            { name: input.name, declaredType: input.contentType, bytes: input.bytes },
          );
          return { id: record.id };
        } catch (error) {
          // A rejected upload (type, content or size) is the caller's input, not a server fault.
          if (error instanceof FileError && UPLOAD_REJECTIONS.has(error.code))
            throw new WorkOrderError('invalid_input');
          throw error;
        }
      },
      read: async (token, correlationId, fileId) => {
        const grant = await files.files.createDownloadGrant(token, correlationId, fileId);
        if (!grant.ok || !grant.value) throw fileFailure(grant.error?.code);
        const served = await files.files.download(token, correlationId, grant.value.grant);
        if (!served.ok || !served.value) throw fileFailure(served.error?.code);
        return served.value.body;
      },
    },
  });
}
