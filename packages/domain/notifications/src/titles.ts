import { MAX_TITLE } from './catalog.js';

/** The label of a record in a title: its folio or economic number, with control characters removed. */
export function cleanLabel(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `prefix · label`, bounded; the prefix is always one of the fixed texts below. */
export function titled(prefix: string, label = ''): string {
  const tail = cleanLabel(label);
  const text = tail === '' ? prefix : `${prefix} · ${tail}`;
  return text.length > MAX_TITLE ? `${text.slice(0, MAX_TITLE - 1)}…` : text;
}

export const EXPIRY_SOURCE_LABELS = {
  vehicle_document: 'Documento',
  insurance_policy: 'Seguro',
  employee_license: 'Licencia de conductor',
} as const;
export type ExpirySource = keyof typeof EXPIRY_SOURCE_LABELS;

export function expiryTitle(source: ExpirySource, days: number, label: string): string {
  const what = EXPIRY_SOURCE_LABELS[source];
  return titled(
    days > 0 ? `${what} vence en ${days} días` : `${what} vence hoy o ya venció`,
    label,
  );
}

export const INCIDENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: 'Borrador',
  reported: 'Reportado',
  under_review: 'En revisión',
  insurance_process: 'Con la aseguradora',
  insurance_rejected: 'Rechazado por la aseguradora',
  no_insurance: 'Sin seguro',
  repair: 'En reparación',
  resolved: 'Resuelto',
  closed: 'Cerrado',
  reopened: 'Reabierto',
  cancelled: 'Cancelado',
};

export const incidentStatusTitle = (status: string, folio: string): string =>
  titled(`Siniestro ${INCIDENT_STATUS_LABELS[status] ?? 'actualizado'}`, folio);
export const incidentCreatedTitle = (folio: string): string => titled('Siniestro nuevo', folio);
export const maintenanceTitle = (overdue: boolean, label: string): string =>
  titled(overdue ? 'Mantenimiento vencido' : 'Mantenimiento próximo', label);
export const outOfServiceTitle = (label: string): string =>
  titled('Vehículo fuera de servicio', label);
export const workOrderTitle = (label: string): string =>
  titled('Orden de mantenimiento asignada', label);
export const membershipTitle = (created: boolean): string =>
  created ? 'Usuario nuevo en la empresa' : 'Cambió el rol de un usuario';
export const exportTitle = (ready: boolean, reportTitle: string): string =>
  titled(ready ? 'Exportación lista' : 'Exportación fallida', reportTitle);
