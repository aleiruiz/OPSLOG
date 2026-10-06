import type { Document } from '../app/types';
import { DOCUMENT_TYPES } from './rules';

/** Synthetic documents for the mock API, tests and stories. Nothing here is real data. */

export function makeDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: 'doc-001',
    ownerType: 'vehicle',
    ownerId: 'veh-001',
    typeCode: 'registration_card',
    title: 'Tarjeta de circulación ECO-001',
    notes: null,
    revision: 1,
    issuedOn: '2025-11-20',
    expiresOn: '2027-11-20',
    documentNumber: 'TC-2025-0001',
    status: 'valid',
    daysToExpiry: 410,
    version: 1,
    createdAt: '2025-11-20T14:30:00.000Z',
    updatedAt: '2025-11-20T14:30:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

/** Employees of the (not yet built) personnel screens that the mock accepts as document owners. */
export const demoEmployeeIds: readonly string[] = ['emp-001', 'emp-002', 'emp-003', 'emp-004'];

const DAY_MS = 86_400_000;
/** Same instant as the mock server clock. */
const TODAY = '2026-10-06';
const shift = (days: number): string =>
  new Date(Date.parse(`${TODAY}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Offsets (days from the mock "today") that cover every status and the inclusive last day. */
const OFFSETS = [-40, -3, 0, 5, 20, 30, 31, 90, 200, 400, 650] as const;

/** `count` documents (every seventh belongs to an employee) with expiries around the mock "today". */
export function demoDocuments(count = 28): Document[] {
  const types = DOCUMENT_TYPES.vehicle.filter((type) => type.expiry === 'required');
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const employee = n % 7 === 0;
    const type = employee
      ? (DOCUMENT_TYPES.employee[0] as (typeof types)[number])
      : (types[index % types.length] as (typeof types)[number]);
    const offset = OFFSETS[index % OFFSETS.length] as number;
    const expiresOn = shift(offset);
    return makeDocument({
      id: `doc-${String(n).padStart(3, '0')}`,
      ownerType: employee ? 'employee' : 'vehicle',
      ownerId: employee
        ? `emp-${String(n / 7).padStart(3, '0')}`
        : `veh-${String(((index * 3) % 28) + 1).padStart(3, '0')}`,
      typeCode: type.code,
      title: `${type.label} ${String(n).padStart(3, '0')}`,
      revision: n === 2 ? 2 : 1,
      issuedOn: shift(offset - 365),
      expiresOn,
      documentNumber: `DOC-${String(n).padStart(4, '0')}`,
      status: offset < 0 ? 'expired' : offset <= 30 ? 'expiring' : 'valid',
      daysToExpiry: offset,
    });
  });
}
