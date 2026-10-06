import type {
  ApiError,
  EmployeeDetail,
  EmployeeInput,
  EmployeeKind,
  EmployeePatch,
} from '../app/types';
import {
  EMAIL,
  EMPLOYEE_NUMBER,
  IDENTIFICATION,
  ID_TYPE,
  LABEL,
  LICENSE_NUMBER,
  LICENSE_TYPE,
  MAX_LICENSE_DATE,
  MIN_DATE,
  NAME,
  PHONE,
  hasLicense,
  isDateBetween,
  normalizeCode,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeUpper,
  todayOf,
} from './rules';

/** What the person types, as text. Everything is normalized only on submit. */
export interface EmployeeFormValues {
  kind: EmployeeKind | '';
  firstName: string;
  lastName: string;
  employeeNumber: string;
  position: string;
  hireDate: string;
  areaId: string;
  licenseType: string;
  licenseExpiresOn: string;
  // Personal data (editable only with the PII permission).
  idType: string;
  nationalId: string;
  phone: string;
  email: string;
  licenseNumber: string;
}

export type FieldKey = keyof EmployeeFormValues;
export type FieldErrors = Partial<Record<FieldKey, string>>;
export type FormMode = 'create' | 'edit';

/** Order in which fields appear, used to move focus to the first one with an error. */
export const fieldOrder: readonly FieldKey[] = [
  'kind',
  'firstName',
  'lastName',
  'employeeNumber',
  'position',
  'hireDate',
  'areaId',
  'idType',
  'nationalId',
  'phone',
  'email',
  'licenseNumber',
  'licenseType',
  'licenseExpiresOn',
];

export const emptyValues = (): EmployeeFormValues => ({
  kind: '',
  firstName: '',
  lastName: '',
  employeeNumber: '',
  position: '',
  hireDate: '',
  areaId: '',
  licenseType: '',
  licenseExpiresOn: '',
  idType: '',
  nationalId: '',
  phone: '',
  email: '',
  licenseNumber: '',
});

/** Values of the loaded employee. Personal data is empty when the session may not see it (`pii` is `null`). */
export const valuesOf = (employee: EmployeeDetail): EmployeeFormValues => ({
  kind: employee.kind,
  firstName: employee.firstName,
  lastName: employee.lastName,
  employeeNumber: employee.employeeNumber ?? '',
  position: employee.position ?? '',
  hireDate: employee.hireDate ?? '',
  areaId: employee.areaId,
  licenseType: employee.licenseType ?? '',
  licenseExpiresOn: employee.licenseExpiresOn ?? '',
  idType: employee.idType ?? '',
  nationalId: employee.pii?.nationalId ?? '',
  phone: employee.pii?.phone ?? '',
  email: employee.pii?.email ?? '',
  licenseNumber: employee.pii?.licenseNumber ?? '',
});

interface Context {
  readonly mode: FormMode;
  readonly now: Date;
  /** The session holds `view_pii`: personal data fields exist and are validated. */
  readonly canEditPii: boolean;
}

const dateText = (iso: string) =>
  new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${iso}T00:00:00Z`),
  );

/** The same rules the backend enforces, with a message per field (the server only says "invalid request"). */
export function validate(values: EmployeeFormValues, context: Context): FieldErrors {
  const errors: FieldErrors = {};
  const today = todayOf(context.now);
  if (context.mode === 'create' && values.kind === '') errors.kind = 'Elige el tipo de empleado.';

  for (const [field, label] of [
    ['firstName', 'el nombre'],
    ['lastName', 'los apellidos'],
  ] as const) {
    const text = normalizeName(values[field]);
    if (!text) errors[field] = `Escribe ${label}.`;
    else if (!NAME.test(text))
      errors[field] =
        'Usa letras, hasta 60 caracteres; se permiten espacio, punto, apóstrofo y guion.';
  }

  const number = values.employeeNumber.trim();
  if (number && !EMPLOYEE_NUMBER.test(number))
    errors.employeeNumber =
      'Usa hasta 32 caracteres: letras, números, punto, guion, guion bajo o diagonal.';

  const position = values.position.trim();
  if (position && !LABEL.test(position))
    errors.position = 'Usa hasta 60 caracteres, sin saltos de línea.';

  const hired = values.hireDate.trim();
  if (hired && !isDateBetween(hired, MIN_DATE, today))
    errors.hireDate = `Elige una fecha entre ${dateText(MIN_DATE)} y hoy.`;

  if (!values.areaId.trim()) errors.areaId = 'Elige el área del empleado.';

  if (hasLicense(values.kind as EmployeeKind)) {
    const type = normalizeUpper(values.licenseType);
    if (type && !LICENSE_TYPE.test(type))
      errors.licenseType =
        'Usa hasta 16 caracteres: letras, números, espacio, punto, guion o guion bajo.';
    const expires = values.licenseExpiresOn.trim();
    if (expires && !isDateBetween(expires, MIN_DATE, MAX_LICENSE_DATE))
      errors.licenseExpiresOn = `Elige una fecha entre ${dateText(MIN_DATE)} y ${dateText(MAX_LICENSE_DATE)}.`;
  }

  if (context.canEditPii) {
    const idType = normalizeCode(values.idType);
    const nationalId = normalizeUpper(values.nationalId);
    if (nationalId && !idType) errors.idType = 'Elige el tipo de identificación.';
    else if (idType && !ID_TYPE.test(idType))
      errors.idType = 'El tipo de identificación no es válido.';
    if (idType && !nationalId) errors.nationalId = 'Escribe el número de identificación.';
    else if (nationalId && !IDENTIFICATION.test(nationalId))
      errors.nationalId =
        'Usa de 4 a 32 caracteres: letras, números, espacio, punto, guion o diagonal.';

    const phone = values.phone.trim();
    if (phone && !PHONE.test(normalizePhone(phone)))
      errors.phone =
        'Usa formato internacional: «+» y de 8 a 15 dígitos, por ejemplo +52 55 5555 0100.';

    const email = normalizeEmail(values.email);
    if (email && (email.length > 254 || !EMAIL.test(email)))
      errors.email = 'Escribe un correo válido, por ejemplo nombre@empresa.com.';

    if (hasLicense(values.kind as EmployeeKind)) {
      const license = normalizeUpper(values.licenseNumber);
      if (license && !LICENSE_NUMBER.test(license))
        errors.licenseNumber =
          'Usa de 4 a 32 caracteres: letras, números, espacio, punto, guion o diagonal.';
    }
  }
  return errors;
}

type Normalized = {
  [K in Exclude<FieldKey, 'kind'>]: string | null;
};

/** Normalized values, `null` for an empty optional field. Personal data is `null` unless `canEditPii`. */
function normalized(values: EmployeeFormValues, canEditPii: boolean): Normalized {
  const driver = hasLicense(values.kind as EmployeeKind);
  const optional = (text: string) => text || null;
  return {
    firstName: normalizeName(values.firstName),
    lastName: normalizeName(values.lastName),
    employeeNumber: optional(values.employeeNumber.trim()),
    position: optional(values.position.trim()),
    hireDate: optional(values.hireDate.trim()),
    areaId: values.areaId.trim(),
    licenseType: driver ? optional(normalizeUpper(values.licenseType)) : null,
    licenseExpiresOn: driver ? optional(values.licenseExpiresOn.trim()) : null,
    idType: canEditPii ? optional(normalizeCode(values.idType)) : null,
    nationalId: canEditPii ? optional(normalizeUpper(values.nationalId)) : null,
    phone: canEditPii ? optional(normalizePhone(values.phone.trim())) : null,
    email: canEditPii ? optional(normalizeEmail(values.email)) : null,
    licenseNumber: canEditPii && driver ? optional(normalizeUpper(values.licenseNumber)) : null,
  };
}

/** Body of a creation. Call only with values that passed `validate`. Empty optional fields are left out. */
export function toInput(values: EmployeeFormValues, canEditPii: boolean): EmployeeInput {
  const n = normalized(values, canEditPii);
  const given = <K extends keyof Normalized>(key: K) =>
    n[key] === null ? {} : ({ [key]: n[key] } as { [P in K]: string });
  return {
    kind: values.kind as EmployeeKind,
    firstName: n.firstName as string,
    lastName: n.lastName as string,
    areaId: n.areaId as string,
    ...given('employeeNumber'),
    ...given('position'),
    ...given('hireDate'),
    ...given('licenseType'),
    ...given('licenseExpiresOn'),
    // An identification travels as a pair; `validate` guarantees both or none.
    ...(n.nationalId !== null && n.idType !== null
      ? { idType: n.idType, nationalId: n.nationalId }
      : {}),
    ...given('phone'),
    ...given('email'),
    ...given('licenseNumber'),
  };
}

/**
 * What changed against the loaded employee, as a patch without `version`; `null` when nothing did. An empty optional
 * field that had a value is sent as `null` (clears it). Personal data is compared only when the session holds the PII
 * permission, so a person without it can never send (or clear) personal data by accident.
 */
export function changes(
  employee: EmployeeDetail,
  values: EmployeeFormValues,
  canEditPii: boolean,
): Omit<EmployeePatch, 'version'> | null {
  const before = normalized(valuesOf(employee), canEditPii);
  const after = normalized({ ...values, kind: employee.kind }, canEditPii);
  const patch: Record<string, string | null> = {};
  const keys: (keyof Normalized)[] = [
    'firstName',
    'lastName',
    'employeeNumber',
    'position',
    'hireDate',
    'areaId',
    'licenseType',
    'licenseExpiresOn',
    'phone',
    'email',
    'licenseNumber',
  ];
  for (const key of keys) if (after[key] !== before[key]) patch[key] = after[key];
  // Identification type and number are one unit on the server: both set, or both cleared.
  if (after.idType !== before.idType || after.nationalId !== before.nationalId) {
    patch['idType'] = after.nationalId === null ? null : after.idType;
    patch['nationalId'] = after.nationalId;
  }
  return Object.keys(patch).length > 0 ? (patch as Omit<EmployeePatch, 'version'>) : null;
}

const duplicateMessages: Record<string, [FieldKey, string]> = {
  employee_number: ['employeeNumber', 'Ya existe un empleado con este número de empleado.'],
  national_id: ['nationalId', 'Ya existe un empleado con esta identificación.'],
  email: ['email', 'Ya existe un empleado con este correo.'],
};

/** Field messages carried by a 409 `duplicate`: only the field name comes back, never the colliding value. */
export function duplicateErrors(error: ApiError): FieldErrors {
  const errors: FieldErrors = {};
  for (const item of error.fieldErrors ?? []) {
    const known = duplicateMessages[item.field];
    if (known) errors[known[0]] = known[1];
  }
  return errors;
}
