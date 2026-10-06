import { describe, expect, it } from 'vitest';
import { makeDocument } from './fixtures';
import {
  allTypes,
  expiryNote,
  formatDate,
  formatDateTime,
  isEditable,
  ownerTypeLabels,
  statusPresentation,
  typeLabel,
} from './labels';
import { isDateBetween, normalizeReference, normalizeText, typeInfo } from './rules';

describe('document labels', () => {
  it('names every status and owner without technical ids', () => {
    expect(Object.values(statusPresentation).map((item) => item.label)).toEqual([
      'Vigente',
      'Por vencer',
      'Vencido',
      'Reemplazado',
    ]);
    expect(ownerTypeLabels).toEqual({ vehicle: 'Vehículo', employee: 'Empleado' });
  });

  it('labels types, falling back to a generic label for an unknown code', () => {
    expect(typeLabel('vehicle', 'registration_card')).toBe('Tarjeta de circulación');
    expect(typeLabel('employee', 'medical_exam')).toBe('Examen médico');
    expect(typeLabel('vehicle', 'tipo_nuevo')).toBe('Otro documento');
    expect(typeInfo('vehicle', 'medical_exam')).toBeUndefined();
  });

  it('lists every type once for a filter without an owner', () => {
    const codes = allTypes().map((type) => type.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain('medical_exam');
    expect(codes).toContain('registration_card');
  });

  it('formats dates in UTC and notes the days to expiry', () => {
    expect(formatDate('2026-10-06')).toBe('6 oct 2026');
    expect(formatDateTime('2026-10-06T12:00:00.000Z')).toMatch(/2026/);
    expect(expiryNote(null)).toBe('Sin vencimiento');
    expect(expiryNote(0)).toBe('Vence hoy');
    expect(expiryNote(1)).toBe('Faltan 1 día');
    expect(expiryNote(12)).toBe('Faltan 12 días');
    expect(expiryNote(-1)).toBe('Venció hace 1 día');
    expect(expiryNote(-30)).toBe('Venció hace 30 días');
  });

  it('is editable until archived', () => {
    expect(isEditable(makeDocument())).toBe(true);
    expect(isEditable(makeDocument({ archivedAt: '2026-09-30T00:00:00.000Z' }))).toBe(false);
  });
});

describe('document rules', () => {
  it('validates real calendar days inside a range', () => {
    expect(isDateBetween('2026-02-28', '1950-01-01', '2100-12-31')).toBe(true);
    expect(isDateBetween('2026-02-29', '1950-01-01', '2100-12-31')).toBe(false);
    expect(isDateBetween('1949-12-31', '1950-01-01', '2100-12-31')).toBe(false);
    expect(isDateBetween('2026-1-1', '1950-01-01', '2100-12-31')).toBe(false);
  });

  it('normalizes text and reference numbers', () => {
    expect(normalizeText('  a   b ')).toBe('a b');
    expect(normalizeReference(' ab   1/2 ')).toBe('AB 1/2');
  });
});
