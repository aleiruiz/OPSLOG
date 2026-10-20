import type { AssignmentStore } from '../../../../../packages/domain/assignments/src/index.js';
import type { AreaService } from '../../../../../packages/domain/areas/src/index.js';
import type { DocumentStore } from '../../../../../packages/domain/documents/src/index.js';
import type { EmployeeService } from '../../../../../packages/domain/employees/src/index.js';
import type { PolicyStore } from '../../../../../packages/domain/insurance/src/index.js';
import {
  MAX_REPORT_ROWS,
  ReportError,
  type PiiField,
  type PiiValues,
  type ReportSources,
} from '../../../../../packages/domain/reports/src/index.js';
import type {
  VehicleAnalyticsReads,
  VehicleService,
  VehicleStore,
} from '../../../../../packages/domain/vehicles/src/index.js';
import { operationalSources, type OperationalInputs } from './report-ops-sources.js';

/** Window the owning modules accept per read. */
const PAGE = 100;
/** Ids per status-history read. */
const ID_CHUNK = 500;

export interface ReportSourceInputs {
  readonly vehicles: VehicleService;
  readonly employees: EmployeeService;
  readonly areas: AreaService;
  readonly assignments: AssignmentStore;
  readonly documents: DocumentStore;
  readonly policies: PolicyStore;
  readonly vehicleStore: VehicleStore;
  readonly now: () => Date;
  /** The stores of the maintenance, incident and audit reports. */
  readonly ops: OperationalInputs;
}

/**
 * Every item of a paginated read. A company with more rows than a report may load gets a refusal
 * that asks for narrower filters, never a truncated file.
 */
async function everything<T>(
  read: (offset: number, limit: number) => Promise<{ items: readonly T[]; total: number }>,
): Promise<readonly T[]> {
  const items: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const slice = await read(offset, PAGE);
    if (slice.total > MAX_REPORT_ROWS) throw new ReportError('too_many_rows');
    items.push(...slice.items);
    if (slice.items.length === 0 || items.length >= slice.total) return items;
  }
}

/**
 * The reads of the reports over the owning modules' services and stores, one company at a time.
 * Nothing here reads a table of another module; personal data is unsealed only for the fields and
 * people asked for.
 */
export function reportSources(inputs: ReportSourceInputs): ReportSources {
  const statusReads = (): VehicleAnalyticsReads => {
    if (
      typeof (inputs.vehicleStore as Partial<VehicleAnalyticsReads>).analyticsStatusChanges !==
      'function'
    )
      throw new Error('The vehicles store does not provide the status history reads');
    return inputs.vehicleStore as VehicleStore & VehicleAnalyticsReads;
  };
  return {
    ...operationalSources(inputs.ops),
    vehicles: async (tenantId) =>
      (await everything((offset, limit) => inputs.vehicles.list(tenantId, { limit, offset }))).map(
        (v) => ({
          id: v.id,
          economicNumber: v.economicNumber,
          plate: v.plate,
          vin: v.vin,
          make: v.make,
          model: v.model,
          year: v.year,
          areaId: v.areaId,
          status: v.status,
          statusReason: v.statusReason,
          odometerKm: v.odometerKm,
          registeredOn: v.registeredOn,
        }),
      ),
    people: async (tenantId, kind) =>
      (
        await everything((offset, limit) =>
          inputs.employees.list(tenantId, { kind, limit, offset }),
        )
      ).map((e) => ({
        id: e.id,
        kind: e.kind,
        firstName: e.firstName,
        lastName: e.lastName,
        employeeNumber: e.employeeNumber,
        position: e.position,
        hireDate: e.hireDate,
        areaId: e.areaId,
        status: e.status,
        licenseType: e.licenseType,
        licenseExpiresOn: e.licenseExpiresOn,
      })),
    areas: async (tenantId) =>
      (
        await everything((offset, limit) =>
          inputs.areas.list(tenantId, { includeInactive: true, limit, offset }),
        )
      ).map((a) => ({
        id: a.id,
        name: a.name,
        code: a.code,
        parentId: a.parentId,
        active: a.active,
        responsibleCount: a.responsibleIds.length,
      })),
    assignments: async (tenantId) =>
      (
        await everything((offset, limit) =>
          inputs.assignments.list(tenantId, { status: 'current' }, { limit, offset }),
        )
      ).map((a) => ({ vehicleId: a.vehicleId, employeeId: a.employeeId, type: a.type })),
    documents: async (tenantId, ownerType) =>
      (
        await everything((offset, limit) =>
          inputs.documents.list(tenantId, { ownerType, includeArchived: false }, { limit, offset }),
        )
      ).map((d) => ({
        id: d.id,
        ownerType: d.ownerType,
        ownerId: d.ownerId,
        typeCode: d.typeCode,
        documentNumber: d.documentNumber,
        issuedOn: d.issuedOn,
        expiresOn: d.expiresOn,
      })),
    policies: async (tenantId, withDeductible) =>
      (
        await everything((offset, limit) =>
          inputs.policies.list(tenantId, { includeArchived: false }, { limit, offset }),
        )
      ).map((p) => ({
        id: p.id,
        vehicleId: p.vehicleId,
        insurer: p.insurer,
        policyNumber: p.policyNumber,
        coverageType: p.coverageType,
        startsOn: p.startsOn,
        endsOn: p.endsOn,
        // Money is read only when the reader holds `view_costs`.
        ...(withDeductible ? { deductible: p.deductible } : {}),
      })),
    statusSince: async (tenantId, vehicleIds) => {
      const since = new Map<string, string>();
      const until = inputs.now().toISOString();
      for (let index = 0; index < vehicleIds.length; index += ID_CHUNK)
        // Oldest first: the last entry of a vehicle is its current state.
        for (const change of await statusReads().analyticsStatusChanges(
          tenantId,
          vehicleIds.slice(index, index + ID_CHUNK),
          until,
        ))
          since.set(change.vehicleId, change.at);
      return since;
    },
    personPii: async (tenantId, personIds, fields) => {
      const result = new Map<string, PiiValues>();
      for (const id of personIds) {
        const employee = await inputs.employees.get(tenantId, id);
        const opened = await inputs.employees.reveal(employee);
        result.set(id, Object.fromEntries(fields.map((field: PiiField) => [field, opened[field]])));
      }
      return result;
    },
  };
}
