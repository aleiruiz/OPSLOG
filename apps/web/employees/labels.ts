import type { StatusTone } from '@opslog/ui';
import type {
  Employee,
  EmployeeHistoryEntry,
  EmployeeKind,
  EmployeeStatus,
  Fitness,
  FitnessReason,
} from '../app/types';

export { formatDate, formatDateTime } from '../vehicles/labels';

/** BRD §7.2.1 labels; the technical ids never reach the screen. */
export const kindLabels: Record<EmployeeKind, string> = {
  driver: 'Conductor',
  dispatcher: 'Despachador',
  other: 'Otro',
};

export const kindOrder: readonly EmployeeKind[] = ['driver', 'dispatcher', 'other'];

export const statusPresentation: Record<EmployeeStatus, { label: string; tone: StatusTone }> = {
  active: { label: 'Activo', tone: 'success' },
  inactive: { label: 'Inactivo', tone: 'neutral' },
  suspended: { label: 'Suspendido', tone: 'warning' },
  terminated: { label: 'Baja', tone: 'danger' },
};

export const statusOrder: readonly EmployeeStatus[] = [
  'active',
  'inactive',
  'suspended',
  'terminated',
];

/** Identification types offered by the forms. The server accepts any catalog code, so others still display. */
export const idTypeLabels: Readonly<Record<string, string>> = {
  ine: 'INE',
  curp: 'CURP',
  rfc: 'RFC',
  passport: 'Pasaporte',
};

export const idTypeOrder: readonly string[] = ['ine', 'curp', 'rfc', 'passport'];

export const idTypeLabel = (code: string): string => idTypeLabels[code] ?? code.toUpperCase();

export const fullName = (employee: Pick<Employee, 'firstName' | 'lastName'>): string =>
  `${employee.firstName} ${employee.lastName}`;

/** List order of the server: last name first. */
export const listName = (employee: Pick<Employee, 'firstName' | 'lastName'>): string =>
  `${employee.lastName}, ${employee.firstName}`;

/** Archived and terminated employees are read-only (the backend answers 409 `immutable`). */
export const isEditable = (employee: Pick<Employee, 'archivedAt' | 'status'>): boolean =>
  employee.archivedAt === null && employee.status !== 'terminated';

/** The status can still change unless the employee is archived or terminated (terminal). */
export const canChangeStatus = isEditable;

/** Archiving is a logical removal: allowed from any status (also a terminated one), not twice. */
export const isArchivable = (employee: Pick<Employee, 'archivedAt'>): boolean =>
  employee.archivedAt === null;

export const fitnessReasonLabels: Record<FitnessReason, string> = {
  not_active: 'El empleado no está activo',
  archived: 'El empleado está archivado',
  license_missing: 'Falta la licencia (número, tipo o vigencia)',
  license_expired: 'La licencia está vencida',
};

export const fitnessPresentation = (
  fitness: Fitness,
): { label: string; tone: StatusTone; reasons: readonly string[] } =>
  fitness.fit
    ? { label: 'Apto para operar', tone: 'success', reasons: [] }
    : {
        label: 'No apto para operar',
        tone: 'danger',
        reasons: fitness.reasons.map((reason) => fitnessReasonLabels[reason]),
      };

/**
 * One line for a history row. Status entries carry status ids (labels come from here); area entries carry area
 * ids, whose names come from the loaded structure. The reason of a status change is shown apart.
 */
export function describeHistory(
  entry: EmployeeHistoryEntry,
  areaName: (areaId: string) => string | null,
): string {
  const place = (id: string | null) =>
    `«${id === null ? 'sin área' : (areaName(id) ?? 'otra área')}»`;
  if (entry.kind === 'area') return `Cambió de área: de ${place(entry.from)} a ${place(entry.to)}`;
  const label = (status: string) =>
    statusPresentation[status as EmployeeStatus]?.label ?? 'otro estado';
  return entry.from === null
    ? `Alta con estado ${label(entry.to)}`
    : `Estado: de ${label(entry.from)} a ${label(entry.to)}`;
}
