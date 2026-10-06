import { describe, expect, it } from 'vitest';
import { makeEmployee, makeHistoryEntry } from './fixtures';
import {
  canChangeStatus,
  describeHistory,
  fitnessPresentation,
  fullName,
  idTypeLabel,
  isArchivable,
  isEditable,
  kindLabels,
  listName,
  statusOrder,
  statusPresentation,
} from './labels';

describe('employee labels', () => {
  it('names every kind and status in Spanish, never by technical id', () => {
    expect(Object.values(kindLabels)).toEqual(['Conductor', 'Despachador', 'Otro']);
    expect(statusOrder.map((status) => statusPresentation[status].label)).toEqual([
      'Activo',
      'Inactivo',
      'Suspendido',
      'Baja',
    ]);
  });

  it('formats names for the detail and for the list order of the server', () => {
    const employee = makeEmployee();
    expect(fullName(employee)).toBe('Ana García López');
    expect(listName(employee)).toBe('García López, Ana');
  });

  it('labels the known identification types and shows any other code in capitals', () => {
    expect(idTypeLabel('ine')).toBe('INE');
    expect(idTypeLabel('passport')).toBe('Pasaporte');
    expect(idTypeLabel('dni')).toBe('DNI');
  });

  it('makes archived and terminated employees read-only, and archiving allowed from anywhere once', () => {
    expect(isEditable(makeEmployee())).toBe(true);
    expect(isEditable(makeEmployee({ status: 'suspended' }))).toBe(true);
    expect(isEditable(makeEmployee({ status: 'terminated' }))).toBe(false);
    expect(isEditable(makeEmployee({ archivedAt: '2026-09-30T10:00:00.000Z' }))).toBe(false);
    expect(canChangeStatus(makeEmployee({ status: 'terminated' }))).toBe(false);
    expect(isArchivable(makeEmployee({ status: 'terminated' }))).toBe(true);
    expect(isArchivable(makeEmployee({ archivedAt: '2026-09-30T10:00:00.000Z' }))).toBe(false);
  });

  it('presents fitness with the reason of each failure', () => {
    expect(fitnessPresentation({ fit: true, reasons: [] })).toEqual({
      label: 'Apto para operar',
      tone: 'success',
      reasons: [],
    });
    const unfit = fitnessPresentation({ fit: false, reasons: ['not_active', 'license_expired'] });
    expect(unfit.label).toBe('No apto para operar');
    expect(unfit.tone).toBe('danger');
    expect(unfit.reasons).toEqual(['El empleado no está activo', 'La licencia está vencida']);
  });

  it('describes status and area history lines, with area names from the structure', () => {
    const names = (id: string) => ({ a: 'Norte', b: 'Sur' })[id] ?? null;
    expect(describeHistory(makeHistoryEntry(), names)).toBe('Alta con estado Activo');
    expect(describeHistory(makeHistoryEntry({ from: 'active', to: 'suspended' }), names)).toBe(
      'Estado: de Activo a Suspendido',
    );
    expect(
      describeHistory(makeHistoryEntry({ kind: 'area', from: 'a', to: 'b', reason: null }), names),
    ).toBe('Cambió de área: de «Norte» a «Sur»');
    expect(
      describeHistory(makeHistoryEntry({ kind: 'area', from: 'x', to: 'b', reason: null }), names),
    ).toBe('Cambió de área: de «otra área» a «Sur»');
    expect(
      describeHistory(makeHistoryEntry({ kind: 'area', from: null, to: 'b', reason: null }), names),
    ).toBe('Cambió de área: de «sin área» a «Sur»');
    expect(describeHistory(makeHistoryEntry({ from: 'active', to: 'raro' }), names)).toBe(
      'Estado: de Activo a otro estado',
    );
  });
});
