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

export const WORK_ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  scheduled: 'Programada',
  assigned: 'Asignada',
  in_progress: 'En proceso',
  completed: 'Completada',
  closed: 'Cerrada',
  cancelled: 'Cancelada',
};

export const WORK_ORDER_KIND_LABELS: Readonly<Record<string, string>> = {
  preventive: 'Preventivo',
  corrective: 'Correctivo',
};

export const INCIDENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  reported: 'Reportado',
  under_review: 'En revisión',
  insurance_process: 'Con la aseguradora',
  insurance_rejected: 'Rechazado por la aseguradora',
  no_insurance: 'Sin aseguradora',
  repair: 'En reparación',
  resolved: 'Resuelto',
  closed: 'Cerrado',
  reopened: 'Reabierto',
  cancelled: 'Cancelado',
};

/** Statuses of a case that is neither a draft nor finished. */
export const OPEN_INCIDENT_STATUSES: readonly string[] = [
  'reported',
  'under_review',
  'insurance_process',
  'insurance_rejected',
  'no_insurance',
  'repair',
  'resolved',
  'reopened',
];

export const INCIDENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  collision: 'Colisión',
  rollover: 'Volcadura',
  theft_total: 'Robo total',
  theft_partial: 'Robo parcial',
  vandalism: 'Vandalismo',
  parking_damage: 'Daño en estacionamiento',
  mechanical_failure: 'Falla mecánica',
  traffic_violation: 'Infracción de tránsito',
  injury: 'Lesión',
  other: 'Otro',
};

export const SEVERITY_LABELS: Readonly<Record<string, string>> = {
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
  critical: 'Crítica',
};

export const COVERAGE_STATUS_LABELS: Readonly<Record<string, string>> = {
  unknown: 'Sin determinar',
  covered: 'Con cobertura',
  multiple: 'Varias pólizas',
  none: 'Sin cobertura',
};

export const SLA_STATE_LABELS: Readonly<Record<string, string>> = {
  not_started: 'Sin iniciar',
  on_track: 'En tiempo',
  warning: 'Por vencer',
  breached: 'Vencido',
  met: 'Cumplido',
  missed: 'Cumplido fuera de plazo',
};

export const EXPENSE_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  repair: 'Reparación sin orden',
  deductible: 'Deducible',
  towing: 'Grúa',
  fine: 'Multa',
  third_party_damage: 'Daño a terceros',
  legal: 'Legal',
  other: 'Otros',
};

export const SOURCE_LABELS = {
  vehicleDocument: 'Documento de vehículo',
  personDocument: 'Documento de persona',
  policy: 'Póliza',
  license: 'Licencia',
  plan: 'Plan de mantenimiento',
} as const;
