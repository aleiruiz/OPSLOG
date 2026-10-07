import {
  AssignmentError,
  AssignmentService,
  InMemoryAssignmentStore,
} from '../../../../../packages/domain/assignments/src/index.js';
import { AlertService } from '../../../../../packages/domain/alerts/src/index.js';
import { AreaService, InMemoryAreaStore } from '../../../../../packages/domain/areas/src/index.js';
import {
  DocumentError,
  DocumentService,
  InMemoryDocumentStore,
} from '../../../../../packages/domain/documents/src/index.js';
import {
  EmployeeError,
  EmployeeService,
  InMemoryEmployeeStore,
} from '../../../../../packages/domain/employees/src/index.js';
import {
  ImportService,
  InMemoryImportStore,
} from '../../../../../packages/domain/imports/src/index.js';
import {
  InMemoryPolicyStore,
  PolicyError,
  PolicyService,
} from '../../../../../packages/domain/insurance/src/index.js';
import {
  InMemorySettingsStore,
  SettingsService,
} from '../../../../../packages/domain/settings/src/index.js';
import {
  InMemoryVehicleStore,
  VehicleError,
  VehicleService,
} from '../../../../../packages/domain/vehicles/src/index.js';
import { EnvelopePiiCipher, LocalDevKms } from '../../../../../packages/platform/pii/src/index.js';
import { AlertsApi } from '../alerts.js';
import { AreasApi } from '../areas.js';
import { AssignmentsApi } from '../assignments.js';
import { DocumentsApi } from '../documents.js';
import { EmployeesApi } from '../employees.js';
import { employeeImportTarget, vehicleImportTarget } from '../import-targets.js';
import { ImportsApi } from '../imports.js';
import { InsuranceApi } from '../insurance.js';
import { CompanySettingsApi } from '../settings.js';
import { VehiclesApi } from '../vehicles.js';
import type { PlatformKernel } from './kernel.js';
import type { PlatformAdapters } from './types.js';

export interface DomainApis {
  readonly vehicles: VehiclesApi;
  readonly areas: AreasApi;
  readonly employees: EmployeesApi;
  readonly documents: DocumentsApi;
  readonly insurance: InsuranceApi;
  readonly assignments: AssignmentsApi;
  readonly imports: ImportsApi;
  readonly companySettings: CompanySettingsApi;
  readonly alerts: AlertsApi;
}

/** Wires the domain services and their HTTP-facing APIs over the adapters (in-memory by default). */
export function buildDomainApis(kernel: PlatformKernel, adapters: PlatformAdapters): DomainApis {
  const vehicleStore = adapters.vehicles ?? new InMemoryVehicleStore();
  // A persistent store with the throwaway local KMS would seal rows that cannot be opened after a
  // restart (and would put real data under a dev key): the cipher must be chosen explicitly.
  if (adapters.employees && !adapters.pii)
    throw new Error('adapters.employees requires adapters.pii (no local KMS fallback)');
  const employeeStore = adapters.employees ?? new InMemoryEmployeeStore();
  const areaService = new AreaService(adapters.areas ?? new InMemoryAreaStore(), {
    now: kernel.now,
    resources: {
      // BR-021: active vehicles are counted through the vehicles store port.
      vehicles: {
        countActive: (tenantId, areaId) => vehicleStore.countLiveInArea(tenantId, areaId),
      },
      // BR-021: live employees are counted through the employees store port.
      people: adapters.people ?? {
        countActive: (tenantId, areaId) => employeeStore.countLiveInArea(tenantId, areaId),
      },
    },
    // FR-041: a responsible user must be an active member of the tenant, per the directory.
    members: {
      isActiveMember: async (tenantId, userId) =>
        (await kernel.access.effectiveRole(tenantId, userId)) !== null,
    },
  });
  const vehicleService = new VehicleService(vehicleStore, {
    now: kernel.now,
    // BR-021 vs. TOCTOU: a vehicle write that sets or changes `areaId` runs under the same
    // per-tenant area lock as `AreaService.deactivate`, after checking the area is active.
    areas: {
      withActiveArea: async (tenantId, areaId, work) => {
        const outcome = await areaService.withActiveArea(tenantId, areaId, work);
        if (!outcome.active) throw new VehicleError('invalid_area', 'area_id');
        return outcome.value;
      },
    },
  });
  const vehicles = new VehiclesApi({
    service: vehicleService,
    authorize: (token, correlationId, required) => kernel.authorize(token, correlationId, required),
    audit: (context, action, entityId, correlationId) =>
      kernel.auditNow(kernel.userActor(context), action, 'vehicle', entityId, correlationId),
  });
  const employeeService = new EmployeeService(employeeStore, {
    now: kernel.now,
    pii:
      adapters.pii ??
      new EnvelopePiiCipher(LocalDevKms.ephemeral(process.env['OPSLOG_ENV'] ?? 'development')),
    // BR-021 vs. TOCTOU: an employee write that sets or changes `areaId` runs under the same
    // per-tenant area lock as `AreaService.deactivate`, after checking the area is active.
    areas: {
      withActiveArea: async (tenantId, areaId, work) => {
        const outcome = await areaService.withActiveArea(tenantId, areaId, work);
        if (!outcome.active) throw new EmployeeError('invalid_area', 'area_id');
        return outcome.value;
      },
    },
  });
  const employees = new EmployeesApi({
    service: employeeService,
    authorize: (token, correlationId, required) => kernel.authorize(token, correlationId, required),
    can: async (context, permission) =>
      (await kernel.access.resolvePermissions(context)).includes(permission),
    audit: (context, action, entityId, correlationId) =>
      kernel.auditNow(kernel.userActor(context), action, 'employee', entityId, correlationId),
  });
  const documentStore = adapters.documents ?? new InMemoryDocumentStore();
  const policyStore = adapters.insurance ?? new InMemoryPolicyStore();
  const documents = new DocumentsApi({
    service: new DocumentService(documentStore, {
      now: kernel.now,
      // The owner of a document must be a live (not archived) vehicle or employee of the same
      // tenant. Unknown, foreign and archived owners are indistinguishable (no tenant oracle).
      owners: {
        assertLive: async (tenantId, ownerType, ownerId) => {
          const found = await (
            ownerType === 'vehicle'
              ? vehicleService.get(tenantId, ownerId)
              : employeeService.get(tenantId, ownerId)
          ).catch((error: unknown) => {
            if (
              (error instanceof VehicleError || error instanceof EmployeeError) &&
              error.code === 'not_found'
            )
              return null;
            throw error;
          });
          if (found === null || found.archivedAt !== null)
            throw new DocumentError('invalid_owner', 'owner_id');
        },
      },
    }),
    authorize: (token, correlationId, required) => kernel.authorize(token, correlationId, required),
    audit: (context, action, entityId, correlationId) =>
      kernel.auditNow(kernel.userActor(context), action, 'document', entityId, correlationId),
  });
  const insurance = new InsuranceApi({
    service: new PolicyService(policyStore, {
      now: kernel.now,
      // The vehicle of a policy must be a live (not archived) vehicle of the same tenant.
      // Unknown, foreign and archived vehicles are indistinguishable (no tenant oracle).
      // Best effort (check, then act): see the task document.
      vehicles: {
        assertLive: async (tenantId, vehicleId) => {
          const found = await vehicleService.get(tenantId, vehicleId).catch((error: unknown) => {
            if (error instanceof VehicleError && error.code === 'not_found') return null;
            throw error;
          });
          if (found === null || found.archivedAt !== null)
            throw new PolicyError('invalid_vehicle', 'vehicle_id');
        },
      },
    }),
    authorize: (token, correlationId, required) => kernel.authorize(token, correlationId, required),
    can: async (context, permission) =>
      (await kernel.access.resolvePermissions(context)).includes(permission),
    audit: (context, action, entityId, correlationId) =>
      kernel.auditNow(
        kernel.userActor(context),
        action,
        'insurance_policy',
        entityId,
        correlationId,
      ),
  });
  const assignments = new AssignmentsApi({
    service: new AssignmentService(adapters.assignments ?? new InMemoryAssignmentStore(), {
      now: kernel.now,
      // BR-014: the vehicle must be live and neither inactive nor decommissioned, and the
      // employee a driver that is active and not archived, both of the same tenant. Unknown,
      // foreign and ineligible ones are indistinguishable (no tenant oracle). Best effort
      // (check, then act): see the task document.
      vehicles: {
        assertAssignable: async (tenantId, vehicleId) => {
          const found = await vehicleService.get(tenantId, vehicleId).catch((error: unknown) => {
            if (error instanceof VehicleError && error.code === 'not_found') return null;
            throw error;
          });
          if (
            found === null ||
            found.archivedAt !== null ||
            found.status === 'inactive' ||
            found.status === 'decommissioned'
          )
            throw new AssignmentError('invalid_vehicle', 'vehicle_id');
        },
      },
      employees: {
        assertAssignable: async (tenantId, employeeId) => {
          const found = await employeeService.get(tenantId, employeeId).catch((error: unknown) => {
            if (error instanceof EmployeeError && error.code === 'not_found') return null;
            throw error;
          });
          if (
            found === null ||
            found.archivedAt !== null ||
            found.kind !== 'driver' ||
            found.status !== 'active'
          )
            throw new AssignmentError('invalid_employee', 'employee_id');
        },
      },
    }),
    authorize: (token, correlationId, required) => kernel.authorize(token, correlationId, required),
    audit: (context, action, entityId, correlationId) =>
      kernel.auditNow(
        kernel.userActor(context),
        action,
        'vehicle_assignment',
        entityId,
        correlationId,
      ),
  });
  const settingsService = new SettingsService(adapters.settings ?? new InMemorySettingsStore(), {
    now: kernel.now,
  });
  const companySettings = new CompanySettingsApi({
    service: settingsService,
    authorize: (token, correlationId, required) => kernel.authorize(token, correlationId, required),
    audit: (context, action, entityId, correlationId) =>
      kernel.auditNow(
        kernel.userActor(context),
        action,
        'company_settings',
        entityId,
        correlationId,
      ),
  });
  // Alerts are derived from the documents and policies stores on every read (no queue, no outbox
  // yet): vehicle documents and insurance policies whose last valid day falls inside the company's
  // window, or already passed. Archived ones are excluded; every read names the tenant.
  const alerts = new AlertsApi({
    service: new AlertService(
      {
        vehicle_document: {
          due: async (tenantId, scope, window) => {
            const slice = await documentStore.list(
              tenantId,
              {
                ownerType: 'vehicle',
                includeArchived: false,
                expiry: scope.expiry,
                ...(scope.vehicleId === undefined ? {} : { ownerId: scope.vehicleId }),
              },
              window,
            );
            return {
              total: slice.total,
              items: slice.items.map((document) => ({
                subjectId: document.id,
                vehicleId: document.ownerId,
                typeCode: document.typeCode,
                dueOn: document.expiresOn as string,
              })),
            };
          },
        },
        insurance_policy: {
          due: async (tenantId, scope, window) => {
            const slice = await policyStore.list(
              tenantId,
              {
                includeArchived: false,
                expiry: scope.expiry,
                ...(scope.vehicleId === undefined ? {} : { vehicleId: scope.vehicleId }),
              },
              window,
            );
            return {
              total: slice.total,
              items: slice.items.map((policy) => ({
                subjectId: policy.id,
                vehicleId: policy.vehicleId,
                typeCode: policy.coverageType,
                dueOn: policy.endsOn,
              })),
            };
          },
        },
      },
      {
        expiryWindowDays: async (tenantId) =>
          (await settingsService.get(tenantId)).expiryWindowDays,
      },
      { now: kernel.now },
    ),
    authorize: (token, correlationId, required) => kernel.authorize(token, correlationId, required),
  });
  const areas = new AreasApi({
    service: areaService,
    authorize: (token, correlationId, required) => kernel.authorize(token, correlationId, required),
    audit: (context, action, entityId, correlationId) =>
      kernel.auditNow(kernel.userActor(context), action, 'area', entityId, correlationId),
  });
  // FLT-IMPORT: rows are created through the vehicle and employee services above, so VIN/plate
  // uniqueness per company, the active-area rule and the sealing of personal data all apply.
  const imports = new ImportsApi({
    service: new ImportService(adapters.imports ?? new InMemoryImportStore(), {
      now: kernel.now,
      targets: {
        vehicle: vehicleImportTarget({ vehicles: vehicleService, areas: areaService }),
        employee: employeeImportTarget({ employees: employeeService, areas: areaService }),
      },
    }),
    authorize: (token, correlationId, required) => kernel.authorize(token, correlationId, required),
    audit: (context, action, entityType, entityId, correlationId) =>
      kernel.auditNow(kernel.userActor(context), action, entityType, entityId, correlationId),
  });
  return {
    vehicles,
    areas,
    employees,
    documents,
    insurance,
    assignments,
    imports,
    companySettings,
    alerts,
  };
}
