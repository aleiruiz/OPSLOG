import type {
  ClosedOrderFact,
  IncidentTimelineFact,
  OpenCaseFact,
  PlanFact,
  StatusEntryFact,
  VehicleFact,
} from './ports.js';
import { emptyFixture, type Fixture } from './test-support.js';

const vehicle = (
  id: string,
  status: VehicleFact['status'],
  over: Partial<VehicleFact> = {},
): VehicleFact => ({
  id,
  areaId: 'area-a',
  status,
  odometerKm: 10_000,
  odometerUpdatedAt: '2026-10-18T00:00:00.000Z',
  archivedAt: null,
  ...over,
});
const entry = (vehicleId: string, to: StatusEntryFact['to'], at: string): StatusEntryFact => ({
  vehicleId,
  to,
  at,
});
const order = (over: Partial<ClosedOrderFact> = {}): ClosedOrderFact => ({
  vehicleId: 'v1',
  kind: 'preventive',
  scheduledDate: null,
  actualDate: null,
  costs: [],
  ...over,
});
const plan = (vehicleId: string, over: Partial<PlanFact> = {}): PlanFact => ({
  vehicleId,
  targetDate: null,
  targetKm: null,
  ...over,
});
const kase = (over: Partial<IncidentTimelineFact>): IncidentTimelineFact => ({
  reportedAt: null,
  firstResolvedAt: null,
  closedAt: null,
  ...over,
});
const open = (severity: OpenCaseFact['severity'], slaBreached = false): OpenCaseFact => ({
  severity,
  slaBreached,
});

/**
 * The company of the acceptance tests, worked out by hand. Today is 2026-10-19 in Mexico City
 * (UTC-6), the range is 2026-10-17 to 2026-10-19 and the local midnights are 06:00Z.
 *
 * Availability, end of each day (live / available):
 *   17 -> v1 v2 v6 v7 v8 = 5 / v1 v2 v6 v7 = 4;  18 -> v1 v2 v3 v6 v8 = 5 / v1 v3 v6 = 3;
 *   19 -> v1 v2 v3 v8 = 4 / v1 v3 = 2.   Mean of 0.8, 0.6 and 0.5 = 0.6333 -> 63.3 %.
 */
export function companyFixture(): Fixture {
  return {
    ...emptyFixture(),
    vehicles: [
      vehicle('v1', 'active'),
      vehicle('v2', 'out_of_service'),
      vehicle('v3', 'active', { areaId: 'area-b' }),
      vehicle('v6', 'active', { archivedAt: '2026-10-19T06:00:00.000Z' }),
      vehicle('v7', 'decommissioned'),
      vehicle('v8', 'restricted', { areaId: 'area-b' }),
      vehicle('v9', 'in_maintenance', { odometerUpdatedAt: null }),
    ],
    entries: [
      entry('v1', 'active', '2026-10-01T10:00:00.000Z'),
      entry('v2', 'active', '2026-10-01T10:00:00.000Z'),
      // Local midnight that opens the 18th: the change belongs to the 18th, not to the 17th.
      entry('v2', 'out_of_service', '2026-10-18T06:00:00.000Z'),
      entry('v3', 'active', '2026-10-18T10:00:00.000Z'),
      entry('v6', 'active', '2026-10-01T10:00:00.000Z'),
      entry('v7', 'active', '2026-10-01T10:00:00.000Z'),
      entry('v7', 'decommissioned', '2026-10-18T20:00:00.000Z'),
      entry('v8', 'restricted', '2026-10-01T10:00:00.000Z'),
    ],
    employees: [
      { id: 'e1', kind: 'driver', status: 'active' },
      { id: 'e2', kind: 'driver', status: 'inactive' },
      { id: 'e3', kind: 'dispatcher', status: 'active' },
    ],
    documentsExpiring: 4,
    insuranceExpiring: 2,
    // Live vehicles: v1 v2 v3 v8 v9 (5 x 4 = 20 slots) and the driver e1 (1 slot).
    validDocuments: [
      ...[
        'registration_card',
        'technical_inspection',
        'transport_permit',
        'municipal_authorization',
      ].map((typeCode) => ({ ownerType: 'vehicle' as const, ownerId: 'v1', typeCode })),
      { ownerType: 'vehicle', ownerId: 'v2', typeCode: 'registration_card' },
      { ownerType: 'vehicle', ownerId: 'v2', typeCode: 'transport_permit' },
      { ownerType: 'vehicle', ownerId: 'v8', typeCode: 'registration_card' },
      // Not counted: archived vehicle, inactive driver, a type that is not required.
      { ownerType: 'vehicle', ownerId: 'v6', typeCode: 'registration_card' },
      { ownerType: 'employee', ownerId: 'e2', typeCode: 'medical_exam' },
      { ownerType: 'vehicle', ownerId: 'v1', typeCode: 'ownership_title' },
      { ownerType: 'employee', ownerId: 'e1', typeCode: 'medical_exam' },
    ],
    covered: ['v1', 'v2', 'v9'],
    plans: [
      plan('v1', { targetDate: '2026-11-03' }),
      plan('v1', { targetDate: '2026-11-04' }),
      plan('v2', { targetKm: 10_400 }),
      plan('v3', { targetKm: 10_501 }),
      plan('v9', { targetKm: 10_400 }),
      plan('v6', { targetDate: '2026-10-20' }),
      plan('v8', { targetDate: '2026-10-01' }),
      plan('v-gone', { targetDate: '2026-10-20' }),
    ],
    orders: [
      order({
        scheduledDate: '2026-10-15',
        actualDate: '2026-10-15',
        costs: [
          { amountMinor: '10000', currency: 'MXN' },
          { amountMinor: '25000', currency: 'MXN' },
        ],
      }),
      order({ scheduledDate: '2026-10-15', actualDate: '2026-10-16' }),
      order({ scheduledDate: null, actualDate: '2026-10-16' }),
      order({
        vehicleId: 'v3',
        kind: 'corrective',
        costs: [
          { amountMinor: '100000', currency: 'USD' },
          { amountMinor: '500', currency: 'MXN' },
        ],
      }),
    ],
    openCases: [open('high'), open('low', true), open('medium'), open('low'), open(null)],
    timeline: [
      kase({ reportedAt: '2026-10-17T05:59:59.000Z' }),
      kase({ reportedAt: '2026-10-17T06:00:00.000Z' }),
      kase({ reportedAt: '2026-10-19T12:00:00.000Z' }),
      kase({
        reportedAt: '2026-10-10T12:00:00.000Z',
        firstResolvedAt: '2026-10-17T12:00:00.000Z',
        closedAt: '2026-10-18T05:00:00.000Z',
      }),
      kase({ reportedAt: '2026-10-12T00:00:00.000Z', firstResolvedAt: '2026-10-18T12:00:00.000Z' }),
      kase({ reportedAt: '2026-10-01T00:00:00.000Z', firstResolvedAt: '2026-10-19T00:00:00.000Z' }),
      kase({ reportedAt: '2026-10-15T00:00:00.000Z', firstResolvedAt: '2026-10-17T07:00:00.000Z' }),
      kase({
        reportedAt: '2026-10-01T00:00:00.000Z',
        firstResolvedAt: '2026-10-20T06:00:00.000Z',
        closedAt: '2026-10-20T06:00:00.000Z',
      }),
    ],
  };
}
