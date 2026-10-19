import type {
  ChangeRecord,
  ChangeScalar,
  ChangeSource,
  EntityDescriber,
} from '../../../../../packages/domain/audit-query/src/index.js';
import { AreaError, type AreaService } from '../../../../../packages/domain/areas/src/index.js';
import {
  EmployeeError,
  type EmployeeService,
} from '../../../../../packages/domain/employees/src/index.js';
import type {
  Incident,
  IncidentStore,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import type { WorkOrderStore } from '../../../../../packages/domain/maintenance/orders/src/index.js';
import {
  VehicleError,
  type VehicleService,
} from '../../../../../packages/domain/vehicles/src/index.js';

/** A module that reports a missing record by an error of its own reads as «not found» here. */
async function found<T>(read: () => Promise<T>, notFound: (error: unknown) => boolean) {
  try {
    return await read();
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

/** The modules whose records the audit describes. Every lookup names the tenant; foreign ids read as absent. */
export interface AuditDescriptionSources {
  readonly vehicles: VehicleService;
  readonly employees: EmployeeService;
  readonly areas: AreaService;
  readonly incidents: IncidentStore;
  readonly workOrders: WorkOrderStore;
}

export function entityDescribers(
  sources: AuditDescriptionSources,
): Readonly<Record<string, EntityDescriber>> {
  return {
    vehicle: {
      describe: async (tenantId, id) => {
        const vehicle = await found(
          () => sources.vehicles.get(tenantId, id),
          (error) => error instanceof VehicleError && error.code === 'not_found',
        );
        return vehicle ? { label: vehicle.economicNumber } : null;
      },
    },
    area: {
      describe: async (tenantId, id) => {
        const area = await found(
          () => sources.areas.get(tenantId, id),
          (error) => error instanceof AreaError && error.code === 'not_found',
        );
        return area ? { label: area.name } : null;
      },
    },
    // An employee number identifies a person: it is shown only with `view_pii`.
    employee: {
      describe: async (tenantId, id) => {
        const employee = await found(
          () => sources.employees.get(tenantId, id),
          (error) => error instanceof EmployeeError && error.code === 'not_found',
        );
        return employee
          ? { label: `Empleado ${employee.employeeNumber ?? ''}`.trim(), pii: true }
          : null;
      },
    },
    incident: {
      describe: async (tenantId, id) => {
        const incident = await sources.incidents.get(tenantId, id);
        return incident ? { label: `Siniestro ${incident.folio}` } : null;
      },
    },
    maintenance_work_order: {
      describe: async (tenantId, id) => {
        const order = await sources.workOrders.get(tenantId, id);
        return order
          ? { label: order.kind === 'preventive' ? 'Orden preventiva' : 'Orden correctiva' }
          : null;
      },
    },
  };
}

/** Structured facts of the case now, with the keys the timeline keeps in `before`. */
function currentFacts(incident: Incident): Readonly<Record<string, ChangeScalar>> {
  return {
    type: incident.type,
    severity: incident.severity,
    vehicleId: incident.vehicleId,
    driverId: incident.driverId,
    occurredAt: incident.occurredAt,
    vehicleOperable: incident.vehicleOperable,
    coverageStatus: incident.coverageStatus,
    policyId: incident.policySnapshot?.policyId ?? null,
    policyRevision: incident.policySnapshot?.revision ?? null,
  };
}

/**
 * The incident timeline keeps names of changed fields and the structured facts before each change. The value
 * after a change is the next entry's «before» of that field, or the case now for the last change.
 */
export function incidentChanges(store: IncidentStore): ChangeSource {
  return {
    changes: async (tenantId, id) => {
      const [history, current] = await Promise.all([
        store.history(tenantId, id),
        store.get(tenantId, id),
      ]);
      const now = current ? currentFacts(current) : {};
      return history.map((entry, index): ChangeRecord => {
        const afterOf = (name: string): ChangeScalar | undefined => {
          for (const later of history.slice(index + 1))
            if (later.before && Object.hasOwn(later.before, name))
              return later.before[name] as ChangeScalar;
          return Object.hasOwn(now, name) ? (now[name] as ChangeScalar) : undefined;
        };
        const status =
          entry.from !== entry.to ? [{ name: 'status', before: entry.from, after: entry.to }] : [];
        return {
          occurredAt: entry.occurredAt,
          command: entry.command,
          fields: [
            ...status,
            ...entry.changedFields.map((name) => {
              const before =
                entry.before && Object.hasOwn(entry.before, name) ? entry.before[name] : undefined;
              const after = afterOf(name);
              return {
                name,
                ...(before === undefined ? {} : { before }),
                ...(after === undefined ? {} : { after }),
              };
            }),
          ],
        };
      });
    },
  };
}

/** Work order timelines keep the status before and after each command; free text and amounts are not read. */
export function workOrderChanges(store: WorkOrderStore): ChangeSource {
  return {
    changes: async (tenantId, id) =>
      (await store.history(tenantId, id)).map(
        (entry): ChangeRecord => ({
          occurredAt: entry.occurredAt,
          command: entry.command,
          fields:
            entry.from === entry.to
              ? []
              : [{ name: 'status', before: entry.from, after: entry.to }],
        }),
      ),
  };
}
