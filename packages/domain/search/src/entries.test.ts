import { describe, expect, it } from 'vitest';
import {
  employeeProjection,
  incidentProjection,
  policyProjection,
  vehicleProjection,
} from './entries.js';
import { employee, incident, policy, vehicle } from './test-support.js';

describe('vehicleProjection', () => {
  it('keys a live vehicle by number, plate and VIN', () => {
    const found = vehicleProjection('t1', vehicle('v1', { vin: '3N6-AD33' }));
    expect(found?.entries.map((e) => [e.keyKind, e.normalized])).toEqual([
      ['economic_number', 'ev1'],
      ['plate', 'abc123'],
      ['vin', '3n6ad33'],
    ]);
    expect(
      found?.entries.every((e) => e.requiredPermission === 'view' && e.tenantId === 't1'),
    ).toBe(true);
  });
  it('does not index an archived vehicle', () => {
    expect(vehicleProjection('t1', vehicle('v1', { archivedAt: AT_ARCHIVED }))).toBeNull();
  });
  it('keeps a row per key kind even when two kinds normalize to the same text', () => {
    const found = vehicleProjection('t1', vehicle('v1', { economicNumber: 'abc-123' }));
    expect(found?.entries.filter((e) => e.normalized === 'abc123')).toHaveLength(2);
  });
  it('drops an empty or oversized key and repeats of the same row', () => {
    const empty = vehicleProjection('t1', vehicle('v1', { vin: '--' }));
    expect(empty?.entries.some((e) => e.keyKind === 'vin')).toBe(false);
    const long = vehicleProjection('t1', vehicle('v1', { vin: 'x'.repeat(200) }));
    expect(long?.entries.some((e) => e.keyKind === 'vin')).toBe(false);
  });
  it('has a fingerprint that follows the facts and ignores the write time', () => {
    const a = vehicleProjection('t1', vehicle('v1'));
    const b = vehicleProjection('t1', vehicle('v1', { updatedAt: '2027-01-01T00:00:00.000Z' }));
    const c = vehicleProjection('t1', vehicle('v1', { plate: 'XYZ-999' }));
    expect(b?.fingerprint).toBe(a?.fingerprint);
    expect(c?.fingerprint).not.toBe(a?.fingerprint);
  });
});

const AT_ARCHIVED = '2026-10-01T00:00:00.000Z';

describe('employeeProjection', () => {
  it('keys a driver by name in both orders and by number', () => {
    const found = employeeProjection('t1', employee('e1'));
    expect(found?.entityType).toBe('driver');
    expect(found?.entries.map((e) => e.normalized)).toEqual(['anaperez', 'perezana', 'ne1']);
    expect(found?.entries[0]?.display).toBe('Ana Pérez');
  });
  it('stores only blind indexes of identification and license, behind view_pii', () => {
    const found = employeeProjection(
      't1',
      employee('e1', { nationalIdIndex: 'a'.repeat(64), licenseIndex: 'b'.repeat(64) }),
    );
    const exact = found?.entries.filter((e) => e.requiredPermission === 'view_pii') ?? [];
    expect(exact.map((e) => [e.keyKind, e.normalized])).toEqual([
      ['identification_hmac', 'a'.repeat(64)],
      ['license', 'b'.repeat(64)],
    ]);
    expect(found?.entries.map((e) => e.display).join('')).not.toContain('aaaa');
  });
  it('indexes dispatchers, and neither other kinds nor archived people', () => {
    expect(employeeProjection('t1', employee('e1', { kind: 'dispatcher' }))?.entityType).toBe(
      'dispatcher',
    );
    expect(employeeProjection('t1', employee('e1', { kind: 'other' }))).toBeNull();
    expect(employeeProjection('t1', employee('e1', { archivedAt: AT_ARCHIVED }))).toBeNull();
  });
  it('writes a name once when both orders read the same', () => {
    const found = employeeProjection('t1', employee('e1', { firstName: 'Li', lastName: 'Li' }));
    expect(found?.entries.filter((e) => e.keyKind === 'name')).toHaveLength(1);
  });
  it('skips the number when the person has none', () => {
    const found = employeeProjection('t1', employee('e1', { employeeNumber: null }));
    expect(found?.entries.some((e) => e.keyKind === 'employee_number')).toBe(false);
  });
});

describe('incidentProjection', () => {
  it('keys by folio and, when it exists, by claim number, for incident viewers', () => {
    const found = incidentProjection('t1', incident('i1', { claimNumber: 'CL 77' }));
    expect(found.entries.map((e) => [e.keyKind, e.normalized, e.requiredPermission])).toEqual([
      ['folio', 'sin2026i1', 'incidents:view'],
      ['claim_number', 'cl77', 'incidents:view'],
    ]);
  });
  it('has no claim row without a claim number', () => {
    expect(incidentProjection('t1', incident('i1')).entries).toHaveLength(1);
  });
});

describe('policyProjection', () => {
  it('keys a live policy by number and skips an archived one', () => {
    expect(policyProjection('t1', policy('p1'))?.entries[0]?.normalized).toBe('polp1');
    expect(policyProjection('t1', policy('p1', { archivedAt: AT_ARCHIVED }))).toBeNull();
  });
});
