import type { VehiclesDatabase } from '../../../packages/persistence/vehicles/src/test-support/mysql.js';

type DataSource = Awaited<ReturnType<VehiclesDatabase['openRuntime']>>;
import { DocumentEntitySchema } from '../../../packages/persistence/documents/src/entities.js';
import { EmployeeEntitySchema } from '../../../packages/persistence/employees/src/entities.js';
import {
  IncidentSchema,
  IncidentTransitionSchema,
} from '../../../packages/persistence/incidents/cases/src/entities.js';
import { PolicyEntitySchema } from '../../../packages/persistence/insurance/src/entities.js';
import {
  WorkOrderCostSchema,
  WorkOrderSchema,
} from '../../../packages/persistence/maintenance/orders/src/entities.js';
import {
  VehicleEntitySchema,
  VehicleStatusEntryEntitySchema,
} from '../../../packages/persistence/vehicles/src/entities.js';

/** The instant the synthetic company lives at: 2026-10-19 12:00 in America/Mexico_City is 18:00Z. */
export const NOW = new Date('2026-10-19T18:00:00.000Z');
const DAY = 86_400_000;
const day = (offset: number): string =>
  new Date(NOW.getTime() + offset * DAY).toISOString().slice(0, 10);
const at = (offsetDays: number): Date => new Date(NOW.getTime() + offsetDays * DAY);

/** Sizes of the SPECS §9.3 dataset for one company: 500 vehicles, 1.000 employees, ~100.000 records. */
export const SIZES = {
  vehicles: 500,
  statusEntriesPerVehicle: 110,
  employees: 1000,
  vehicleDocuments: 8000,
  employeeDocuments: 4000,
  policies: 2500,
  orders: 12000,
  incidents: 6000,
} as const;

const VEHICLE_TYPES = [
  'registration_card',
  'technical_inspection',
  'transport_permit',
  'municipal_authorization',
  'ownership_title',
  'other',
];
const EMPLOYEE_TYPES = ['medical_exam', 'training_certificate', 'driving_course', 'other'];

/** Inserts `total` rows built by `make`, 500 at a time, through the module's own ORM schema. */
async function fill<T extends object>(
  source: DataSource,
  schema: Parameters<DataSource['getRepository']>[0],
  total: number,
  make: (n: number) => T,
): Promise<void> {
  const repository = source.getRepository(schema as never);
  for (let from = 0; from < total; from += 500) {
    const rows: T[] = [];
    for (let n = from; n < Math.min(total, from + 500); n += 1) rows.push(make(n));
    await repository.insert(rows as never);
  }
}

export const seedVehicles = async (
  source: DataSource,
  tenantId: string,
  areas: readonly string[],
  count: number = SIZES.vehicles,
) => {
  await fill(source, VehicleEntitySchema, count, (n) => ({
    tenantId,
    id: `veh-${n}`,
    economicNumber: `ECO-${n}`,
    economicNumberKey: `eco-${n}`,
    plate: `PL${n}`,
    plateKey: `PL${n}`,
    vin: null,
    make: 'Marca',
    model: 'Modelo',
    year: 2020,
    areaId: areas[n % areas.length],
    status:
      n % 10 === 0
        ? 'out_of_service'
        : n % 17 === 0
          ? 'in_maintenance'
          : n % 23 === 0
            ? 'restricted'
            : 'active',
    statusReason: 'Carga sintética',
    odometerKm: 1000 + n,
    odometerUpdatedAt: at(-(n % 30)),
    registeredOn: '2025-01-01',
    version: 1,
    createdAt: at(-400),
    updatedAt: at(-1),
    archivedAt: n % 40 === 0 ? at(-3) : null,
  }));
  await fill(source, VehicleStatusEntryEntitySchema, count * SIZES.statusEntriesPerVehicle, (n) => {
    const vehicle = Math.floor(n / SIZES.statusEntriesPerVehicle);
    const step = n % SIZES.statusEntriesPerVehicle;
    return {
      tenantId,
      id: `se-${vehicle}-${step}`,
      vehicleId: `veh-${vehicle}`,
      fromStatus: step === 0 ? null : step % 2 === 0 ? 'restricted' : 'active',
      toStatus: step % 2 === 0 ? 'active' : 'restricted',
      reason: 'Carga sintética',
      actorId: 'user-seed',
      version: step + 1,
      at: at(-400 + step * 4),
    };
  });
};

export const seedEmployees = (
  source: DataSource,
  tenantId: string,
  areas: readonly string[],
  count: number = SIZES.employees,
) =>
  fill(source, EmployeeEntitySchema, count, (n) => ({
    tenantId,
    id: `emp-${n}`,
    kind: n % 10 === 0 ? 'dispatcher' : 'driver',
    firstName: `Nombre${n}`,
    lastName: `Apellido${n}`,
    nameKey: `apellido${n} nombre${n}`,
    employeeNumber: `EN-${n}`,
    employeeNumberKey: `en-${n}`,
    position: null,
    hireDate: null,
    areaId: areas[n % areas.length],
    status: n % 7 === 0 ? 'inactive' : 'active',
    statusReason: 'Carga sintética',
    idType: null,
    nationalIdEnc: null,
    nationalIdIdx: null,
    phoneEnc: null,
    emailEnc: null,
    emailIdx: null,
    licenseNumberEnc: null,
    licenseNumberIdx: null,
    licenseType: null,
    licenseExpiresOn: null,
    version: 1,
    createdAt: at(-400),
    updatedAt: at(-1),
    archivedAt: n % 50 === 0 ? at(-3) : null,
  }));

export const seedDocuments = async (
  source: DataSource,
  tenantId: string,
  vehicles: number = SIZES.vehicles,
  employees = SIZES.employees,
) => {
  const document = (n: number, owner: 'vehicle' | 'employee') => {
    const expires = n % 10 === 0 ? null : day((n % 120) - 40);
    return {
      tenantId,
      id: `doc-${owner}-${n}`,
      ownerType: owner,
      vehicleId: owner === 'vehicle' ? `veh-${n % vehicles}` : null,
      employeeId: owner === 'employee' ? `emp-${n % employees}` : null,
      typeCode:
        owner === 'vehicle'
          ? VEHICLE_TYPES[n % VEHICLE_TYPES.length]
          : EMPLOYEE_TYPES[n % EMPLOYEE_TYPES.length],
      title: 'Documento sintético',
      notes: null,
      revision: 1,
      issuedOn: null,
      expiresOn: expires,
      expiryKey: expires ?? '9999-12-31',
      documentNumber: null,
      version: 1,
      createdAt: at(-100),
      updatedAt: at(-1),
      archivedAt: n % 25 === 0 ? at(-2) : null,
    };
  };
  await fill(source, DocumentEntitySchema, SIZES.vehicleDocuments, (n) => document(n, 'vehicle'));
  await fill(source, DocumentEntitySchema, SIZES.employeeDocuments, (n) => document(n, 'employee'));
};

export const seedPolicies = (
  source: DataSource,
  tenantId: string,
  vehicles: number = SIZES.vehicles,
) =>
  fill(source, PolicyEntitySchema, SIZES.policies, (n) => ({
    tenantId,
    id: `pol-${n}`,
    vehicleId: `veh-${n % vehicles}`,
    insurer: 'Aseguradora Ficticia',
    coverageNotes: null,
    revision: 1,
    policyNumber: `POL-${n}`,
    coverageType: 'comprehensive',
    startsOn: day(-300 + (n % 200)),
    endsOn: day(-60 + (n % 400)),
    deductibleKind: null,
    deductibleValue: null,
    deductibleCurrency: null,
    version: 1,
    createdAt: at(-300),
    updatedAt: at(-1),
    archivedAt: n % 30 === 0 ? at(-2) : null,
  }));

export const seedOrders = async (
  source: DataSource,
  tenantId: string,
  vehicles: number = SIZES.vehicles,
) => {
  const closed = (n: number) => n % 10 !== 0;
  await fill(source, WorkOrderSchema, SIZES.orders, (n) => {
    const preventive = n % 10 < 3;
    const closedAt = closed(n) ? at(-(n % 700)) : null;
    return {
      tenantId,
      id: `ord-${n}`,
      kind: preventive ? 'preventive' : 'corrective',
      vehicleId: `veh-${n % vehicles}`,
      planId: preventive ? `plan-${n}` : null,
      occurrenceId: preventive ? `occ-${n}` : null,
      status: closedAt ? 'closed' : 'scheduled',
      version: 1,
      description: null,
      responsibleId: null,
      workshopId: null,
      mechanicId: null,
      scheduledDate: day(-(n % 700) + 2),
      requiresWorkshop: false,
      startedAt: null,
      completedAt: null,
      actualDate: closedAt ? day(-(n % 700)) : null,
      actualKm: null,
      closeApprovedBy: null,
      closeApprovedAt: null,
      closedAt,
      closedBy: closedAt ? 'user-seed' : null,
      vehicleStatusDecision: closedAt ? 'active' : null,
      cancelReason: null,
      reopenCount: 0,
      createdAt: at(-720),
      createdBy: 'user-seed',
      updatedAt: at(-1),
      updatedBy: 'user-seed',
    };
  });
  await fill(source, WorkOrderCostSchema, SIZES.orders * 1.25, (n) => ({
    tenantId,
    orderId: `ord-${n % SIZES.orders}`,
    id: `cost-${n}`,
    position: Math.floor(n / SIZES.orders),
    category: 'labor',
    amountMinor: String(10_000 + n),
    currency: n % 4 === 0 ? 'USD' : 'MXN',
  }));
};

export const seedIncidents = async (
  source: DataSource,
  tenantId: string,
  areas: readonly string[],
  vehicles: number = SIZES.vehicles,
) => {
  const status = (n: number) =>
    n % 20 < 2
      ? 'reported'
      : n % 20 === 2
        ? 'under_review'
        : n % 20 === 3
          ? 'repair'
          : n % 20 === 4
            ? 'draft'
            : 'closed';
  await fill(source, IncidentSchema, SIZES.incidents, (n) => {
    const state = status(n);
    const reportedAt = state === 'draft' ? null : at(-(n % 600) - 1);
    const reopened = n % 25 === 0 && state !== 'draft';
    return {
      tenantId,
      id: `inc-${n}`,
      folio: `SIN-2026-${String(n + 1).padStart(6, '0')}`,
      status: state,
      version: 1,
      cycle: reopened ? 2 : 1,
      reopenCount: reopened ? 1 : 0,
      type: 'other',
      severity: ['low', 'medium', 'high', 'critical'][n % 4],
      vehicleId: `veh-${n % vehicles}`,
      areaId: areas[(n % vehicles) % areas.length],
      driverId: null,
      noDriverReason: null,
      occurredAt: null,
      occurredOn: null,
      locationText: null,
      locationLatitude: null,
      locationLongitude: null,
      description: null,
      vehicleOperable: null,
      damageDescription: null,
      damageZones: [],
      noPhotoJustification: null,
      coverageStatus: 'unknown',
      policySnapshot: null,
      reportedAt,
      reportedBy: reportedAt ? 'user-seed' : null,
      responsibleId: null,
      insurerName: null,
      claimNumber: null,
      adjusterName: null,
      adjusterContact: null,
      insurerReportedOn: null,
      insurerResult: null,
      rejectionReason: null,
      appealNote: null,
      noInsuranceReason: null,
      costAssumed: null,
      resolutionSummary: null,
      totalLoss: null,
      vehicleStatusDecision: null,
      resolvedAt:
        state === 'closed' && reportedAt ? new Date(reportedAt.getTime() + 5 * DAY) : null,
      assumptionApprovedBy: null,
      assumptionApprovedAt: null,
      closeApprovedBy: null,
      closeApprovedAt: null,
      closedAt: state === 'closed' && reportedAt ? new Date(reportedAt.getTime() + 6 * DAY) : null,
      closedBy: state === 'closed' ? 'user-seed' : null,
      cancelReason: null,
      createdAt: at(-700),
      createdBy: 'user-seed',
      updatedAt: at(-1),
      updatedBy: 'user-seed',
    };
  });
  // Every reopened case keeps the `resolve` entry of its first cycle on the timeline.
  const reopened = Array.from({ length: SIZES.incidents }, (_, n) => n).filter(
    (n) => n % 25 === 0 && status(n) !== 'draft',
  );
  await fill(source, IncidentTransitionSchema, reopened.length, (k) => {
    const n = reopened[k] as number;
    return {
      tenantId,
      incidentId: `inc-${n}`,
      sequence: 1,
      command: 'resolve',
      fromStatus: null,
      toStatus: 'resolved',
      actorId: 'user-seed',
      comment: null,
      occurredAt: at(-(n % 600) + 2),
      changedFields: [],
      before: null,
    };
  });
};
