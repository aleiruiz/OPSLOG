/** Spanish labels of the catalogs the reports print; an unknown code prints as itself. */
export const VEHICLE_STATUS_LABELS: Readonly<Record<string, string>> = {
  active: 'Activo',
  restricted: 'Restringido',
  in_maintenance: 'En mantenimiento',
  out_of_service: 'Fuera de servicio',
  inactive: 'Inactivo',
  decommissioned: 'Baja',
};

export const EMPLOYEE_STATUS_LABELS: Readonly<Record<string, string>> = {
  active: 'Activo',
  inactive: 'Inactivo',
  suspended: 'Suspendido',
  terminated: 'Baja',
};

export const PERSON_KIND_LABELS: Readonly<Record<string, string>> = {
  driver: 'Conductor',
  dispatcher: 'Despachador',
  other: 'Otro',
};

export const DOCUMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  valid: 'Vigente',
  expiring: 'Por vencer',
  expired: 'Vencido',
};

export const POLICY_STATUS_LABELS: Readonly<Record<string, string>> = {
  valid: 'Vigente',
  expiring: 'Por vencer',
  expired: 'Vencida',
};

export const VEHICLE_DOCUMENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  registration_card: 'Tarjeta de circulación',
  technical_inspection: 'Verificación técnica',
  transport_permit: 'Permiso de transporte',
  municipal_authorization: 'Autorización municipal',
  ownership_title: 'Factura o título de propiedad',
  other: 'Otro',
};

export const EMPLOYEE_DOCUMENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  medical_exam: 'Examen médico',
  training_certificate: 'Constancia de capacitación',
  driving_course: 'Curso de manejo',
  other: 'Otro',
};

export const COVERAGE_LABELS: Readonly<Record<string, string>> = {
  mandatory_liability: 'Responsabilidad civil obligatoria',
  third_party: 'Daños a terceros',
  comprehensive: 'Cobertura amplia',
  other: 'Otra',
};

export const label = (labels: Readonly<Record<string, string>>, code: string): string =>
  labels[code] ?? code;

export const optionsOf = (labels: Readonly<Record<string, string>>) =>
  Object.entries(labels).map(([value, text]) => ({ value, label: text }));

/** The status of a document or policy as of a day, with the 30-day window of the module. */
export function expiryStatus(
  expiresOn: string | null,
  daysLeft: number | null,
): 'valid' | 'expiring' | 'expired' {
  if (expiresOn === null || daysLeft === null) return 'valid';
  return daysLeft < 0 ? 'expired' : daysLeft <= 30 ? 'expiring' : 'valid';
}
