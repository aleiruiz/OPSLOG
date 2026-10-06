import { describe, expect, it } from 'vitest';
import { makeVehicle } from './fixtures';
import {
  formatDate,
  formatDateTime,
  formatKm,
  isArchivable,
  isEditable,
  statusOrder,
  statusPresentation,
} from './labels';

describe('vehicle labels', () => {
  it('names every status in Spanish and never exposes the technical id', () => {
    expect(statusOrder).toHaveLength(6);
    expect(statusOrder.map((status) => statusPresentation[status].label)).toEqual([
      'Activo',
      'Restringido',
      'En mantenimiento',
      'Fuera de servicio',
      'Inactivo',
      'Baja',
    ]);
  });

  it('formats kilometres and dates for es-MX', () => {
    expect(formatKm(48250)).toBe('48,250 km');
    expect(formatDate('2024-03-15')).toBe('15 mar 2024');
    expect(formatDate('2024-03-15T14:30:00.000Z')).toMatch(/15 mar 2024/);
    expect(formatDateTime('2026-10-01T16:45:00.000Z')).toMatch(/2026/);
  });

  it('tells which vehicles can be edited or archived', () => {
    const active = makeVehicle();
    const decommissioned = makeVehicle({ status: 'decommissioned' });
    const archived = makeVehicle({ archivedAt: '2026-09-30T10:00:00.000Z' });
    expect([active, decommissioned, archived].map(isEditable)).toEqual([true, false, false]);
    expect([active, decommissioned, archived].map(isArchivable)).toEqual([true, true, false]);
  });
});
