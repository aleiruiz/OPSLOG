import type { ApiError, AssignmentEnd, AssignmentInput, AssignmentType } from '../app/types';
import { ASSIGNMENT_TYPES, OPAQUE_ID, REASON, normalizeReason } from './rules';

/** What the person types and picks, as text. `replace` is a checkbox. */
export interface AssignFormValues {
  vehicleId: string;
  employeeId: string;
  type: string;
  reason: string;
  replace: boolean;
}

export interface EndFormValues {
  reason: string;
}

export type AssignFieldKey = 'vehicleId' | 'employeeId' | 'type' | 'reason';
export type AssignFieldErrors = Partial<Record<AssignFieldKey, string>>;
export type EndFieldErrors = Partial<Record<'reason', string>>;
export type FormMode = 'assign' | 'end';

/** Order in which fields appear, used to move focus to the first one with an error. */
export const assignFieldOrder: readonly AssignFieldKey[] = [
  'vehicleId',
  'employeeId',
  'type',
  'reason',
];

export const emptyAssign: AssignFormValues = {
  vehicleId: '',
  employeeId: '',
  type: 'principal',
  reason: '',
  replace: false,
};

export const emptyEnd: EndFormValues = { reason: '' };

const REASON_HELP = 'Usa de 1 a 200 caracteres, sin saltos de línea.';

function reasonError(value: string, empty: string): string | undefined {
  const reason = normalizeReason(value);
  if (!reason) return empty;
  return REASON.test(reason) ? undefined : REASON_HELP;
}

/** The same rules the backend enforces, with a message per field (the server only says "invalid request"). */
export function validateAssign(values: AssignFormValues): AssignFieldErrors {
  const errors: AssignFieldErrors = {};
  if (!values.vehicleId.trim()) errors.vehicleId = 'Elige el vehículo.';
  else if (!OPAQUE_ID.test(values.vehicleId.trim()))
    errors.vehicleId = 'El vehículo elegido no es válido. Elige otro de la lista.';
  if (!values.employeeId.trim()) errors.employeeId = 'Elige el conductor.';
  else if (!OPAQUE_ID.test(values.employeeId.trim()))
    errors.employeeId = 'El conductor elegido no es válido. Elige otro de la lista.';
  if (!values.type) errors.type = 'Elige el tipo de asignación.';
  else if (!(ASSIGNMENT_TYPES as readonly string[]).includes(values.type))
    errors.type = 'El tipo elegido no existe. Elige uno de la lista.';
  const reason = reasonError(values.reason, 'Escribe el motivo de la asignación.');
  if (reason) errors.reason = reason;
  return errors;
}

export function validateEnd(values: EndFormValues): EndFieldErrors {
  const reason = reasonError(values.reason, 'Escribe el motivo del cierre.');
  return reason ? { reason } : {};
}

/**
 * Body of an assignment. `replace` is sent only when it is on and the type is principal (the backend answers 400 for a
 * replacement of any other type). Call only with values that passed `validateAssign`.
 */
export function toInput(values: AssignFormValues): AssignmentInput {
  const type = values.type as AssignmentType;
  return {
    vehicleId: values.vehicleId.trim(),
    employeeId: values.employeeId.trim(),
    type,
    reason: normalizeReason(values.reason),
    ...(values.replace && type === 'principal' ? { replace: true } : {}),
  };
}

/** Body of a closure (without the version). */
export function toEnd(values: EndFormValues): Omit<AssignmentEnd, 'version'> {
  return { reason: normalizeReason(values.reason) };
}

/** Whether a field error of the server names `field` (`vehicle_id`, `employee_id`). */
export const namesField = (error: ApiError, field: string): boolean =>
  error.fieldErrors?.some((item) => item.field === field) ?? false;

/** The rejections of an assignment that name one of the two pickers, as a message next to that picker. */
export function pickerErrors(error: ApiError): AssignFieldErrors {
  const errors: AssignFieldErrors = {};
  if (error.code === 'invalid_vehicle' && namesField(error, 'vehicle_id'))
    errors.vehicleId =
      'El vehículo no existe, está archivado, inactivo o dado de baja. Elige otro de la lista.';
  if (error.code === 'invalid_employee' && namesField(error, 'employee_id'))
    errors.employeeId =
      'El conductor no existe o no puede ser asignado: debe ser un conductor activo y no archivado. Elige otro de la lista.';
  if (error.code === 'principal_taken' && namesField(error, 'employee_id'))
    errors.employeeId = 'Este conductor ya es el principal de otro vehículo.';
  if (error.code === 'already_assigned' && namesField(error, 'employee_id'))
    errors.employeeId = 'Este conductor ya tiene una asignación vigente a este vehículo.';
  return errors;
}
