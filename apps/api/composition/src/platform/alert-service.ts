import { AlertService } from '../../../../../packages/domain/alerts/src/index.js';
import type { DocumentStore } from '../../../../../packages/domain/documents/src/index.js';
import type { EmployeeStore } from '../../../../../packages/domain/employees/src/index.js';
import type { PolicyStore } from '../../../../../packages/domain/insurance/src/index.js';
import type { SettingsService } from '../../../../../packages/domain/settings/src/index.js';
import { driverLicenseAlerts } from '../driver-license-alerts.js';

export interface AlertStores {
  readonly documentStore: DocumentStore;
  readonly policyStore: PolicyStore;
  readonly employeeStore: EmployeeStore;
}

/**
 * The alerts of documents, policies and driver licences, derived from their stores on every read.
 * The alerts screen and the notification scan read the same service, so both announce the same things.
 */
export function buildAlertService(
  { documentStore, policyStore, employeeStore }: AlertStores,
  settingsService: Pick<SettingsService, 'get'>,
  now: () => Date,
): AlertService {
  return new AlertService(
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
      employee_license: driverLicenseAlerts(employeeStore),
    },
    {
      expiryWindowDays: async (tenantId) => (await settingsService.get(tenantId)).expiryWindowDays,
    },
    { now },
  );
}
