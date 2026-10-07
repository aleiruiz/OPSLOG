import { describe, expect, it } from 'vitest';
import type { ApiError } from '../app/types';
import {
  emptyAssign,
  namesField,
  pickerErrors,
  toEnd,
  toInput,
  validateAssign,
  validateEnd,
} from './formModel';
import { assignableVehicleStatus, normalizeReason } from './rules';

const error = (code: string, status: ApiError['status'], field?: string): ApiError => ({
  code,
  status,
  message: 'x',
  correlationId: 'c',
  ...(field ? { fieldErrors: [{ field, code, message: 'x' }] } : {}),
});
const valid = {
  ...emptyAssign,
  vehicleId: 'veh-001',
  employeeId: 'emp-001',
  reason: 'Ruta norte',
};

describe('assignment form rules', () => {
  it('accepts a complete form and explains each missing or malformed field', () => {
    expect(validateAssign(valid)).toEqual({});
    expect(validateAssign(emptyAssign)).toEqual({
      vehicleId: 'Elige el vehículo.',
      employeeId: 'Elige el conductor.',
      reason: 'Escribe el motivo de la asignación.',
    });
    expect(
      validateAssign({ ...valid, vehicleId: '../x', employeeId: ' no valido', type: '' }),
    ).toEqual({
      vehicleId: 'El vehículo elegido no es válido. Elige otro de la lista.',
      employeeId: 'El conductor elegido no es válido. Elige otro de la lista.',
      type: 'Elige el tipo de asignación.',
    });
    expect(validateAssign({ ...valid, type: 'permanent' }).type).toBe(
      'El tipo elegido no existe. Elige uno de la lista.',
    );
  });

  it('limits the reason to one line of 200 characters', () => {
    expect(validateAssign({ ...valid, reason: 'a'.repeat(200) })).toEqual({});
    expect(validateAssign({ ...valid, reason: 'a'.repeat(201) }).reason).toBe(
      'Usa de 1 a 200 caracteres, sin saltos de línea.',
    );
    // Whitespace, line breaks included, collapses to one space like on the server; other control characters are refused.
    expect(validateAssign({ ...valid, reason: 'uno\ndos' })).toEqual({});
    expect(validateAssign({ ...valid, reason: 'uno\u0007dos' }).reason).toBe(
      'Usa de 1 a 200 caracteres, sin saltos de línea.',
    );
    expect(validateEnd({ reason: '   ' })).toEqual({ reason: 'Escribe el motivo del cierre.' });
    expect(validateEnd({ reason: 'Fin de la ruta' })).toEqual({});
    expect(normalizeReason('  mucho   espacio ')).toBe('mucho espacio');
  });

  it('builds the request with a normalized reason and replace only for a principal', () => {
    expect(toInput({ ...valid, reason: ' Ruta   norte ' })).toEqual({
      vehicleId: 'veh-001',
      employeeId: 'emp-001',
      type: 'principal',
      reason: 'Ruta norte',
    });
    expect(toInput({ ...valid, replace: true })).toMatchObject({ replace: true });
    expect(Object.hasOwn(toInput({ ...valid, type: 'secondary', replace: true }), 'replace')).toBe(
      false,
    );
    expect(toEnd({ reason: ' Fin  de ruta ' })).toEqual({ reason: 'Fin de ruta' });
  });

  it('turns the rejections that name a picker into a message for that picker', () => {
    expect(namesField(error('principal_taken', 409, 'vehicle_id'), 'vehicle_id')).toBe(true);
    expect(namesField(error('internal_error', 500), 'vehicle_id')).toBe(false);
    expect(pickerErrors(error('invalid_vehicle', 422, 'vehicle_id')).vehicleId).toMatch(
      /archivado, inactivo o dado de baja/,
    );
    expect(pickerErrors(error('invalid_employee', 422, 'employee_id')).employeeId).toMatch(
      /conductor activo y no archivado/,
    );
    expect(pickerErrors(error('principal_taken', 409, 'employee_id')).employeeId).toBe(
      'Este conductor ya es el principal de otro vehículo.',
    );
    expect(pickerErrors(error('already_assigned', 409, 'employee_id')).employeeId).toMatch(
      /ya tiene una asignación vigente a este vehículo/,
    );
    // The vehicle conflict is an alert with an action, not a field message; other errors name nothing.
    expect(pickerErrors(error('principal_taken', 409, 'vehicle_id'))).toEqual({});
    expect(pickerErrors(error('internal_error', 500))).toEqual({});
  });

  it('offers every vehicle but the inactive and decommissioned ones (BR-014)', () => {
    expect(assignableVehicleStatus(undefined)).toBe(true);
    for (const status of ['active', 'restricted', 'in_maintenance', 'out_of_service'] as const)
      expect(assignableVehicleStatus(status)).toBe(true);
    expect(assignableVehicleStatus('inactive')).toBe(false);
    expect(assignableVehicleStatus('decommissioned')).toBe(false);
  });
});
