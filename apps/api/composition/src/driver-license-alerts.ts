import { matchesExpiry, MAX_LIST_LIMIT } from '../../../../packages/domain/documents/src/index.js';
import type {
  AlertCandidateSlice,
  AlertScope,
  AlertSource,
  AlertWindow,
} from '../../../../packages/domain/alerts/src/index.js';
import type { EmployeeStore } from '../../../../packages/domain/employees/src/index.js';

/** Derived license alerts expose only the employee id and expiry date; PII fields are never read. */
export function driverLicenseAlerts(employees: EmployeeStore): AlertSource {
  return {
    async due(
      tenantId: string,
      scope: AlertScope,
      window: AlertWindow,
    ): Promise<AlertCandidateSlice> {
      if (scope.vehicleId !== undefined) return { items: [], total: 0 };
      const due: { subjectId: string; vehicleId: null; typeCode: string; dueOn: string }[] = [];
      let offset = 0;
      let totalEmployees = 0;
      do {
        const page = await employees.list(
          tenantId,
          { kind: 'driver', status: 'active', includeArchived: false },
          { limit: MAX_LIST_LIMIT, offset },
        );
        totalEmployees = page.total;
        for (const employee of page.items) {
          const dueOn = employee.licenseExpiresOn;
          if (dueOn !== null && matchesExpiry(dueOn, scope.expiry))
            due.push({
              subjectId: employee.id,
              vehicleId: null,
              typeCode: 'driver_license',
              dueOn,
            });
        }
        offset += MAX_LIST_LIMIT;
      } while (offset < totalEmployees);
      due.sort((a, b) =>
        a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : a.subjectId < b.subjectId ? -1 : 1,
      );
      return { items: due.slice(window.offset, window.offset + window.limit), total: due.length };
    },
  };
}
