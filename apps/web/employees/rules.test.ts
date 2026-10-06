import { describe, expect, it } from 'vitest';
import {
  EMAIL,
  EMPLOYEE_NUMBER,
  IDENTIFICATION,
  ID_TYPE,
  LABEL,
  LICENSE_NUMBER,
  LICENSE_TYPE,
  NAME,
  PHONE,
  canTransition,
  fitnessOf,
  hasLicense,
  isDateBetween,
  isReasonValid,
  normalizeCode,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeUpper,
} from './rules';

describe('field rules (mirror of the domain)', () => {
  it('accepts names with accents, apostrophes and hyphens and rejects digits, symbols and over-long text', () => {
    for (const ok of ['Ana', 'María José', "O'Connor", 'Pérez-Gómez', 'Ñandú', 'D’Artagnan'])
      expect(NAME.test(ok)).toBe(true);
    for (const bad of ['', '1ana', 'Ana3', '-Ana', 'x'.repeat(61), 'Ana\nLópez'])
      expect(NAME.test(bad)).toBe(false);
  });

  it('checks every other pattern on a good and a bad value', () => {
    const cases: [RegExp, string, string][] = [
      [EMPLOYEE_NUMBER, 'E-0001', '-E1'],
      [LABEL, 'Operadora', 'a\nb'],
      [ID_TYPE, 'ine', 'INE'],
      [IDENTIFICATION, 'EJEM 8001-01', 'ab'],
      [LICENSE_NUMBER, 'LIC-000123', 'lic'],
      [LICENSE_TYPE, 'C', 'c!'],
      [PHONE, '+525555550100', '5555550100'],
      [EMAIL, 'ana@ejemplo.test', 'ana@ejemplo'],
    ];
    for (const [pattern, good, bad] of cases) {
      expect(pattern.test(good)).toBe(true);
      expect(pattern.test(bad)).toBe(false);
    }
  });

  it('normalizes the way the server does', () => {
    expect(normalizeName('  Ana   María ')).toBe('Ana María');
    expect(normalizeUpper(' ejem  800-1 ')).toBe('EJEM 800-1');
    expect(normalizeEmail(' Ana@Ejemplo.TEST ')).toBe('ana@ejemplo.test');
    expect(normalizePhone('+52 (55) 5555-0100')).toBe('+525555550100');
    expect(normalizePhone('+52 55.5555.0100')).toBe('+525555550100');
    expect(normalizeCode(' INE ')).toBe('ine');
  });

  it('validates real calendar dates inside a range, inclusive', () => {
    expect(isDateBetween('2026-10-06', '1950-01-01', '2026-10-06')).toBe(true);
    expect(isDateBetween('2026-10-07', '1950-01-01', '2026-10-06')).toBe(false);
    expect(isDateBetween('1949-12-31', '1950-01-01', '2100-12-31')).toBe(false);
    expect(isDateBetween('2026-02-31', '1950-01-01', '2100-12-31')).toBe(false);
    expect(isDateBetween('2026-2-3', '1950-01-01', '2100-12-31')).toBe(false);
    expect(isDateBetween('', '1950-01-01', '2100-12-31')).toBe(false);
  });

  it('requires a one-line reason of up to 200 characters', () => {
    expect(isReasonValid('Baja voluntaria')).toBe(true);
    expect(isReasonValid('x'.repeat(200))).toBe(true);
    for (const bad of ['', '   ', 'x'.repeat(201), 'a\nb', 'a\tb'])
      expect(isReasonValid(bad)).toBe(false);
  });
});

describe('status matrix', () => {
  it('moves between live states and to terminated, and never leaves terminated', () => {
    expect(canTransition('active', 'suspended')).toBe(true);
    expect(canTransition('suspended', 'active')).toBe(true);
    expect(canTransition('inactive', 'terminated')).toBe(true);
    expect(canTransition('active', 'active')).toBe(false);
    for (const to of ['active', 'inactive', 'suspended', 'terminated'] as const)
      expect(canTransition('terminated', to)).toBe(false);
  });

  it('gives only drivers license data', () => {
    expect(hasLicense('driver')).toBe(true);
    expect(hasLicense('dispatcher')).toBe(false);
    expect(hasLicense('other')).toBe(false);
  });
});

describe('fitness to operate (BR-012)', () => {
  const base = {
    kind: 'driver' as const,
    status: 'active' as const,
    archivedAt: null,
    licenseType: 'C',
    licenseExpiresOn: '2026-10-06',
    piiPresent: { nationalId: false, phone: false, email: false, licenseNumber: true },
  };
  it('is fit with an active, unarchived driver whose license expires today or later (inclusive)', () => {
    expect(fitnessOf(base, '2026-10-06')).toEqual({ fit: true, reasons: [] });
  });
  it('is not fit once the license day has passed', () => {
    expect(fitnessOf(base, '2026-10-07')).toEqual({ fit: false, reasons: ['license_expired'] });
  });
  it('lists every reason that applies, in a fixed order', () => {
    expect(
      fitnessOf(
        { ...base, status: 'suspended', archivedAt: '2026-01-01T00:00:00.000Z', licenseType: null },
        '2026-10-06',
      ),
    ).toEqual({ fit: false, reasons: ['archived', 'not_active', 'license_missing'] });
    expect(
      fitnessOf({ ...base, piiPresent: { ...base.piiPresent, licenseNumber: false } }, '2026-10-06')
        ?.reasons,
    ).toEqual(['license_missing']);
    expect(fitnessOf({ ...base, licenseExpiresOn: null }, '2026-10-06')?.reasons).toEqual([
      'license_missing',
    ]);
  });
  it('does not exist for anyone who is not a driver', () => {
    expect(fitnessOf({ ...base, kind: 'dispatcher' }, '2026-10-06')).toBeNull();
    expect(fitnessOf({ ...base, kind: 'other' }, '2026-10-06')).toBeNull();
  });
});
