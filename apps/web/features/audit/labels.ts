import type { StatusTone } from '@opslog/ui';
import type { BffAuditChange, BffAuditEntry } from '@opslog/contracts';
import {
  SEVERITY_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
  VEHICLE_DECISION_LABELS,
  INSURER_RESULT_LABELS,
  ZONE_LABELS,
} from '../incidents/labels';
import { STATUS_LABELS as WORK_ORDER_STATUS } from '../maintenance/labels';

/** Action domains offered by the filter (the server only accepts these prefixes). */
export const DOMAIN_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'vehicle.', label: 'Vehículos' },
  { value: 'vehicle_assignment.', label: 'Asignaciones' },
  { value: 'employee.', label: 'Empleados' },
  { value: 'area.', label: 'Áreas' },
  { value: 'document.', label: 'Documentos' },
  { value: 'insurance_policy.', label: 'Pólizas' },
  { value: 'import_job.', label: 'Importaciones' },
  { value: 'company_settings.', label: 'Ajustes de la empresa' },
  { value: 'file.', label: 'Archivos' },
  { value: 'incident.', label: 'Siniestros' },
  { value: 'maintenance.', label: 'Mantenimiento' },
  { value: 'tenant.', label: 'Empresa' },
  { value: 'user.', label: 'Usuarios' },
  { value: 'invitation.', label: 'Invitaciones' },
  { value: 'membership.', label: 'Accesos' },
  { value: 'role.', label: 'Roles' },
];

/** Record kinds offered by the filter. */
export const ENTITY_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'vehicle', label: 'Vehículo' },
  { value: 'assignment', label: 'Asignación' },
  { value: 'employee', label: 'Empleado' },
  { value: 'area', label: 'Área' },
  { value: 'document', label: 'Documento' },
  { value: 'insurance_policy', label: 'Póliza' },
  { value: 'import_job', label: 'Importación' },
  { value: 'incident', label: 'Siniestro' },
  { value: 'maintenance_work_order', label: 'Orden de trabajo' },
  { value: 'maintenance_plan', label: 'Plan de mantenimiento' },
  { value: 'company_settings', label: 'Ajustes de la empresa' },
  { value: 'role', label: 'Rol' },
];

export const RESULT_OPTIONS = [
  { value: 'success', label: 'Realizada' },
  { value: 'denied', label: 'Denegada' },
] as const;

export const resultView = (
  result: BffAuditEntry['result'],
): { readonly label: string; readonly tone: StatusTone } =>
  result === 'denied'
    ? { label: 'Denegada', tone: 'danger' }
    : { label: 'Realizada', tone: 'success' };

/** Codes of enumerated fields that travel as values, translated with the incident labels. */
const CODE_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  status: STATUS_LABELS,
  type: TYPE_LABELS,
  severity: SEVERITY_LABELS,
  insurerResult: INSURER_RESULT_LABELS,
  vehicleStatusDecision: VEHICLE_DECISION_LABELS,
  zone: ZONE_LABELS,
};

/** A recorded value as text: codes translated, booleans as Sí/No, nothing technical. */
export function formatChangeValue(
  field: string,
  value: string | number | boolean | null | undefined,
  entityType: string,
): string {
  if (value === null || value === undefined || value === '') return 'Sin dato';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (typeof value === 'string') {
    const table =
      entityType === 'maintenance_work_order' && field === 'status'
        ? (WORK_ORDER_STATUS as Readonly<Record<string, string>>)
        : CODE_LABELS[field];
    return table?.[value] ?? value;
  }
  return String(value);
}

/** One side of a change as text; restricted and unrecorded fields never show a value. */
export function describeChangeSide(
  change: BffAuditChange,
  side: 'before' | 'after',
  entityType: string,
): string {
  if (change.state === 'restricted') return 'valor restringido';
  if (change.state === 'not_recorded') return 'no registrado';
  return formatChangeValue(change.field, change[side], entityType);
}
