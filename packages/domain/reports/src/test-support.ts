import type { Permission } from '../../identity/src/index.js';
import { createReportCatalog } from './catalog.js';
import { ReportEngine } from './engine.js';
import type {
  AreaFact,
  AssignmentFact,
  DocumentFact,
  PersonFact,
  PiiField,
  PiiValues,
  PolicyFact,
  ReportSources,
  VehicleFact,
} from './ports.js';

export interface TenantData {
  vehicles: VehicleFact[];
  people: PersonFact[];
  areas: AreaFact[];
  assignments: AssignmentFact[];
  documents: DocumentFact[];
  policies: PolicyFact[];
  statusSince: Record<string, string>;
  pii: Record<string, PiiValues>;
}

const area = (id: string, name: string, extra: Partial<AreaFact> = {}): AreaFact => ({
  id,
  name,
  code: null,
  parentId: null,
  active: true,
  responsibleCount: 0,
  ...extra,
});

const vehicle = (id: string, n: number, extra: Partial<VehicleFact> = {}): VehicleFact => ({
  id,
  economicNumber: `ECO-${n}`,
  plate: `PLA-${n}00`,
  vin: null,
  make: 'Kenworth',
  model: 'T680',
  year: 2020,
  areaId: 'a1',
  status: 'active',
  statusReason: '',
  odometerKm: 1000 * n,
  registeredOn: '2024-01-15',
  ...extra,
});

const person = (
  id: string,
  first: string,
  last: string,
  extra: Partial<PersonFact> = {},
): PersonFact => ({
  id,
  kind: 'driver',
  firstName: first,
  lastName: last,
  employeeNumber: null,
  position: null,
  hireDate: null,
  areaId: 'a1',
  status: 'active',
  licenseType: null,
  licenseExpiresOn: null,
  ...extra,
});

/** Company A of the fixtures; today is 2026-10-19 in `America/Mexico_City`. */
export function companyA(): TenantData {
  return {
    areas: [
      area('a1', 'Norte', { code: 'N', responsibleCount: 2 }),
      area('a2', 'Sur', { parentId: 'a1', active: false }),
    ],
    vehicles: [
      vehicle('v1', 1, {
        vin: '1HGBH41JXMN109186',
        status: 'in_maintenance',
        statusReason: 'Cambio de motor',
      }),
      vehicle('v2', 2, { make: 'Volvo', model: 'FH', year: 2018, areaId: 'a2', status: 'active' }),
      vehicle('v3', 3, { make: 'Volvo', model: 'VNL', year: 2022, status: 'decommissioned' }),
    ],
    people: [
      person('d1', 'Ana', 'Zúñiga', {
        employeeNumber: 'E-01',
        position: 'Operadora',
        hireDate: '2023-03-01',
        licenseType: 'federal',
        licenseExpiresOn: '2026-11-01',
      }),
      person('d2', 'Beto', 'Álvarez', {
        employeeNumber: 'E-02',
        areaId: 'a2',
        status: 'suspended',
        hireDate: '2021-06-10',
        licenseType: 'estatal',
        licenseExpiresOn: '2027-02-01',
      }),
      person('d3', 'Carla', 'Núñez', { status: 'terminated', licenseType: 'federal' }),
      person('s1', 'Diego', 'Soto', {
        kind: 'dispatcher',
        position: 'Turno noche',
        employeeNumber: 'D-01',
      }),
      person('o1', 'Elena', 'Ruiz', { kind: 'other', areaId: 'a2' }),
    ],
    assignments: [
      { vehicleId: 'v1', employeeId: 'd1', type: 'principal' },
      { vehicleId: 'v2', employeeId: 'd1', type: 'secondary' },
      { vehicleId: 'v2', employeeId: 'd2', type: 'principal' },
    ],
    documents: [
      {
        id: 'x1',
        ownerType: 'vehicle',
        ownerId: 'v1',
        typeCode: 'registration_card',
        documentNumber: 'TC-1',
        issuedOn: '2025-01-01',
        expiresOn: '2026-10-25',
      },
      {
        id: 'x2',
        ownerType: 'vehicle',
        ownerId: 'v2',
        typeCode: 'technical_inspection',
        documentNumber: null,
        issuedOn: null,
        expiresOn: '2026-10-01',
      },
      {
        id: 'x3',
        ownerType: 'vehicle',
        ownerId: 'v2',
        typeCode: 'ownership_title',
        documentNumber: 'F-9',
        issuedOn: '2020-01-01',
        expiresOn: null,
      },
      {
        id: 'x4',
        ownerType: 'vehicle',
        ownerId: 'v1',
        typeCode: 'transport_permit',
        documentNumber: 'P-1',
        issuedOn: null,
        expiresOn: '2027-06-01',
      },
      {
        id: 'y1',
        ownerType: 'employee',
        ownerId: 'd1',
        typeCode: 'medical_exam',
        documentNumber: 'M-1',
        issuedOn: '2025-11-01',
        expiresOn: '2026-10-19',
      },
      {
        id: 'y2',
        ownerType: 'employee',
        ownerId: 'd2',
        typeCode: 'medical_exam',
        documentNumber: null,
        issuedOn: null,
        expiresOn: '2026-09-30',
      },
      {
        id: 'y3',
        ownerType: 'employee',
        ownerId: 'd2',
        typeCode: 'driving_course',
        documentNumber: null,
        issuedOn: null,
        expiresOn: '2026-08-01',
      },
      {
        id: 'y4',
        ownerType: 'employee',
        ownerId: 'o1',
        typeCode: 'other',
        documentNumber: null,
        issuedOn: null,
        expiresOn: '2027-12-31',
      },
      {
        id: 'y5',
        ownerType: 'employee',
        ownerId: 'ghost',
        typeCode: 'other',
        documentNumber: null,
        issuedOn: null,
        expiresOn: null,
      },
    ],
    policies: [
      {
        id: 'p1',
        vehicleId: 'v1',
        insurer: 'Qualitas',
        policyNumber: 'Q-100',
        coverageType: 'comprehensive',
        startsOn: '2026-01-01',
        endsOn: '2026-11-30',
        deductible: { kind: 'amount', amountMinor: 1500050, currency: 'MXN' },
      },
      {
        id: 'p2',
        vehicleId: 'v2',
        insurer: 'GNP Seguros',
        policyNumber: 'G-7',
        coverageType: 'mandatory_liability',
        startsOn: '2025-01-01',
        endsOn: '2026-10-18',
        deductible: { kind: 'percent', basisPoints: 1250 },
      },
      {
        id: 'p3',
        vehicleId: 'v1',
        insurer: 'Qualitas',
        policyNumber: 'Q-101',
        coverageType: 'other',
        startsOn: '2026-01-01',
        endsOn: '2027-03-01',
        deductible: null,
      },
      {
        id: 'p4',
        vehicleId: 'ghost',
        insurer: 'Fantasma',
        policyNumber: 'F-1',
        coverageType: 'other',
        startsOn: '2026-01-01',
        endsOn: '2027-03-01',
        deductible: null,
      },
    ],
    // 2026-10-10 03:00 UTC is still 2026-10-09 in Mexico City.
    statusSince: { v1: '2026-10-10T03:00:00.000Z', v2: '2026-09-19T18:00:00.000Z' },
    pii: {
      d1: { licenseNumber: 'LIC-ANA-001' },
      d2: { licenseNumber: 'LIC-BETO-002' },
      s1: { phone: '+52 55 5555 0101', email: 'diego@example.test' },
    },
  };
}

/** Company B: the same shapes with different ids, to prove nothing crosses companies. */
export function companyB(): TenantData {
  return {
    ...companyA(),
    areas: [area('b1', 'Bajío')],
    vehicles: [vehicle('bv1', 9, { areaId: 'b1', economicNumber: 'B-ECO-9' })],
    people: [person('bd1', 'Bruno', 'Bravo', { areaId: 'b1' })],
    assignments: [],
    documents: [],
    policies: [],
    statusSince: {},
    pii: { bd1: { licenseNumber: 'LIC-BRUNO-777' } },
  };
}

export class MemorySources implements ReportSources {
  public readonly piiReads: { tenantId: string; fields: readonly PiiField[] }[] = [];
  public readonly policyReads: { tenantId: string; withDeductible: boolean }[] = [];
  public constructor(public readonly tenants: Record<string, TenantData>) {}
  private data(tenantId: string): TenantData {
    const found = this.tenants[tenantId];
    if (!found) throw new Error('unknown tenant');
    return found;
  }
  public async vehicles(tenantId: string) {
    return this.data(tenantId).vehicles;
  }
  public async people(tenantId: string, kind: PersonFact['kind']) {
    return this.data(tenantId).people.filter((p) => p.kind === kind);
  }
  public async areas(tenantId: string) {
    return this.data(tenantId).areas;
  }
  public async assignments(tenantId: string) {
    return this.data(tenantId).assignments;
  }
  public async documents(tenantId: string, ownerType: DocumentOwner) {
    return this.data(tenantId).documents.filter((d) => d.ownerType === ownerType);
  }
  public async policies(tenantId: string, withDeductible: boolean) {
    this.policyReads.push({ tenantId, withDeductible });
    return this.data(tenantId).policies.map((policy) => {
      const { deductible, ...rest } = policy;
      return withDeductible ? { ...rest, deductible: deductible ?? null } : rest;
    });
  }
  public async statusSince(tenantId: string, vehicleIds: readonly string[]) {
    const since = this.data(tenantId).statusSince;
    return new Map(vehicleIds.filter((id) => id in since).map((id) => [id, since[id] as string]));
  }
  public async personPii(
    tenantId: string,
    personIds: readonly string[],
    fields: readonly PiiField[],
  ) {
    this.piiReads.push({ tenantId, fields });
    const pii = this.data(tenantId).pii;
    return new Map(
      personIds.map((id) => {
        const all = pii[id] ?? {};
        const picked: Record<string, string | null> = {};
        for (const field of fields) picked[field] = all[field] ?? null;
        return [id, picked] as const;
      }),
    );
  }
}
type DocumentOwner = DocumentFact['ownerType'];

export const NOW = new Date('2026-10-19T16:00:00.000Z');
export const ZONE = 'America/Mexico_City';

export const READER: readonly Permission[] = ['view'];
export const ALL: readonly Permission[] = [
  'view',
  'export',
  'view_pii',
  'view_costs',
  'incidents:view_costs',
];

export function engineFor(
  sources: MemorySources = new MemorySources({ A: companyA(), B: companyB() }),
) {
  const engine = new ReportEngine(createReportCatalog(), {
    sources,
    timeZone: async () => ZONE,
    now: () => NOW,
  });
  return { engine, sources };
}

/** Runs one report as a reader with the given permissions and returns the projected rows. */
export async function runReport(
  id: string,
  permissions: readonly Permission[],
  request: Parameters<ReportEngine['plan']>[2] = {},
  tenantId = 'A',
  sources?: MemorySources,
) {
  const { engine } = engineFor(sources);
  const perms = new Set(permissions);
  const plan = engine.plan(id, perms, request);
  const ctx = await engine.context(tenantId, perms);
  return engine.run(ctx, plan);
}
