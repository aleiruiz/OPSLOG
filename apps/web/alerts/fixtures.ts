import { BFF_ALERT_RECIPIENT_ROLES } from '@opslog/contracts';
import type { Alert, AlertSettings } from '../app/types';
import { DOCUMENT_TYPES } from '../documents/rules';
import { COVERAGE_TYPES } from '../insurance/rules';

/** Synthetic alerts and settings for tests and stories. Nothing here is real data. */

export function makeAlert(overrides: Partial<Alert> = {}): Alert {
  const base = {
    source: 'vehicle_document' as const,
    subjectId: 'doc-001',
    dueOn: '2026-10-11',
    ...overrides,
  };
  return {
    key: `${base.source}:${base.subjectId}:${base.dueOn}`,
    vehicleId: 'veh-001',
    typeCode: 'registration_card',
    daysToExpiry: 5,
    severity: 'expiring',
    ...base,
    ...overrides,
  };
}

export function makeSettings(overrides: Partial<AlertSettings> = {}): AlertSettings {
  return {
    expiryWindowDays: 30,
    recipientRoles: ['admin', 'editor'],
    version: 3,
    updatedBy: 'user-admin',
    updatedAt: '2026-10-01T15:00:00.000Z',
    ...overrides,
  };
}

/** Settings of a company that never saved: the defaults at version 0. */
export const unsavedSettings: AlertSettings = {
  expiryWindowDays: 30,
  recipientRoles: ['admin', 'editor'],
  version: 0,
  updatedBy: null,
  updatedAt: null,
};

export const allRecipientRoles = BFF_ALERT_RECIPIENT_ROLES;

const DAY_MS = 86_400_000;
const TODAY = '2026-10-06';
const shift = (days: number): string =>
  new Date(Date.parse(`${TODAY}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
const OFFSETS = [-40, -3, 0, 5, 12, 20, 30] as const;

/** `count` alerts around the mock "today": both sources, both severities and the inclusive last day. */
export function demoAlerts(count = 8): Alert[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const offset = OFFSETS[index % OFFSETS.length] as number;
    const policy = n % 3 === 0;
    return makeAlert({
      source: policy ? 'insurance_policy' : 'vehicle_document',
      subjectId: `${policy ? 'pol' : 'doc'}-${String(n).padStart(3, '0')}`,
      vehicleId: `veh-${String(((index * 2) % 28) + 1).padStart(3, '0')}`,
      typeCode: policy
        ? (COVERAGE_TYPES[index % COVERAGE_TYPES.length] as string)
        : (DOCUMENT_TYPES.vehicle[index % 4]?.code as string),
      dueOn: shift(offset),
      daysToExpiry: offset,
      severity: offset < 0 ? 'expired' : 'expiring',
    });
  });
}
