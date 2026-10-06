import type { Deductible, InsurancePolicy } from '../app/types';
import { COVERAGE_TYPES } from './rules';

/** Synthetic policies for the mock API, tests and stories. Nothing here is real data. */

export function makePolicy(overrides: Partial<InsurancePolicy> = {}): InsurancePolicy {
  return {
    id: 'pol-001',
    vehicleId: 'veh-001',
    insurer: 'Aseguradora Demo Norte',
    coverageNotes: null,
    revision: 1,
    policyNumber: 'POL-2026-0001',
    coverageType: 'comprehensive',
    startsOn: '2026-03-01',
    endsOn: '2027-02-28',
    status: 'valid',
    daysToExpiry: 145,
    covering: true,
    hasDeductible: false,
    deductible: null,
    version: 1,
    createdAt: '2026-02-20T14:30:00.000Z',
    updatedAt: '2026-02-20T14:30:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

const DAY_MS = 86_400_000;
/** Same instant as the mock server clock. */
const TODAY = '2026-10-06';
const shift = (days: number): string =>
  new Date(Date.parse(`${TODAY}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Offsets (days from the mock "today") of the last covered day: every status and the inclusive last day. */
const OFFSETS = [-40, -3, 0, 5, 20, 30, 31, 90, 200, 364] as const;
const INSURERS = ['Aseguradora Demo Norte', 'Seguros Demo Centro', 'Protección Demo Sur'] as const;
const DEDUCTIBLES: readonly (Deductible | null)[] = [
  null,
  { kind: 'amount', amountMinor: 1_250_000, currency: 'MXN' },
  { kind: 'percent', basisPoints: 1500 },
];

/** `count` policies ordered by number: every status, three insurers, a not-yet-started one, all three deductible kinds. */
export function demoPolicies(count = 28): InsurancePolicy[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const futureStart = n % 9 === 0;
    const offset = futureStart ? 375 : (OFFSETS[index % OFFSETS.length] as number);
    const endsOn = shift(offset);
    const startsOn = futureStart ? shift(10) : shift(offset - 364);
    const deductible = DEDUCTIBLES[index % DEDUCTIBLES.length] ?? null;
    return makePolicy({
      id: `pol-${String(n).padStart(3, '0')}`,
      vehicleId: `veh-${String(((index * 2) % 28) + 1).padStart(3, '0')}`,
      insurer: INSURERS[index % INSURERS.length] as string,
      policyNumber: `POL-2026-${String(n).padStart(4, '0')}`,
      coverageType: COVERAGE_TYPES[
        index % COVERAGE_TYPES.length
      ] as InsurancePolicy['coverageType'],
      revision: n === 2 ? 2 : 1,
      startsOn,
      endsOn,
      status: offset < 0 ? 'expired' : offset <= 30 ? 'expiring' : 'valid',
      daysToExpiry: offset,
      covering: !futureStart && offset >= 0,
      hasDeductible: deductible !== null,
      deductible,
    });
  });
}
