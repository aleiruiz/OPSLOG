import type {
  AnalyticsSources,
  ClosedOrderFact,
  EmployeeFact,
  IncidentTimelineFact,
  OpenCaseFact,
  PlanFact,
  RequiredDocumentFact,
  StatusEntryFact,
  VehicleFact,
} from './ports.js';

export const TENANT = 'tenant-a';
export const ZONE = 'America/Mexico_City';
/** 2026-10-19 12:00 in Mexico City (UTC-6). */
export const NOW = new Date('2026-10-19T18:00:00.000Z');

export interface Fixture {
  areaSubtree: Record<string, readonly string[]>;
  vehicles: readonly VehicleFact[];
  entries: readonly StatusEntryFact[];
  employees: readonly EmployeeFact[];
  validDocuments: readonly RequiredDocumentFact[];
  documentsExpiring: number;
  insuranceExpiring: number;
  covered: readonly string[];
  plans: readonly PlanFact[];
  orders: readonly ClosedOrderFact[];
  openCases: readonly OpenCaseFact[];
  timeline: readonly IncidentTimelineFact[];
  company: { timeZone: string; expiryWindowDays: number };
}

export const emptyFixture = (): Fixture => ({
  areaSubtree: {},
  vehicles: [],
  entries: [],
  employees: [],
  validDocuments: [],
  documentsExpiring: 0,
  insuranceExpiring: 0,
  covered: [],
  plans: [],
  orders: [],
  openCases: [],
  timeline: [],
  company: { timeZone: ZONE, expiryWindowDays: 30 },
});

export type Calls = { name: string; args: unknown[] }[];

/** Sources over a fixture that record every call, so tests can prove what was (not) read. */
export function fixtureSources(fixture: Fixture): { sources: AnalyticsSources; calls: Calls } {
  const calls: Calls = [];
  const record =
    <T>(name: string, value: () => T) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ name, args });
      return value();
    };
  const sources: AnalyticsSources = {
    company: record('company', () => fixture.company),
    areaSubtree: async (tenantId, areaId) => {
      calls.push({ name: 'areaSubtree', args: [tenantId, areaId] });
      return fixture.areaSubtree[areaId] ?? null;
    },
    fleet: {
      vehicles: record('vehicles', () => fixture.vehicles),
      statusEntries: record('statusEntries', () => fixture.entries),
      employees: record('employees', () => fixture.employees),
    },
    documents: {
      countExpiring: record('documents.countExpiring', () => fixture.documentsExpiring),
      validRequired: record('documents.validRequired', () => fixture.validDocuments),
    },
    insurance: {
      countExpiring: record('insurance.countExpiring', () => fixture.insuranceExpiring),
      coveredVehicleIds: record('insurance.covered', () => fixture.covered),
    },
    maintenance: {
      plans: record('plans', () => fixture.plans),
      closedOrders: record('closedOrders', () => fixture.orders),
    },
    incidents: {
      openCases: record('openCases', () => fixture.openCases),
      timeline: record('timeline', () => fixture.timeline),
    },
  };
  return { calls, sources };
}
