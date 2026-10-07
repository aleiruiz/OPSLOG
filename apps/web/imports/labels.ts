import type { StatusTone } from '@opslog/ui';
import type {
  ImportEntity,
  ImportEvent,
  ImportMode,
  ImportOutcome,
  ImportRowCode,
  ImportStatus,
} from '../app/types';

export { formatDateTime } from '../vehicles/labels';

export const entityLabels: Record<ImportEntity, string> = {
  vehicle: 'Vehículos',
  employee: 'Empleados',
};
export const entityLabel = (code: string): string =>
  (entityLabels as Record<string, string>)[code] ?? 'Otros registros';

/** Where a created record of each entity can be opened. */
export const entityPaths: Record<ImportEntity, string> = {
  vehicle: '/flota/vehiculos',
  employee: '/plantilla/empleados',
};

export const modeLabels: Record<ImportMode, string> = {
  dry_run: 'Solo validar',
  commit_valid: 'Importar las filas válidas',
  commit_all: 'Importar todo o nada',
};
export const modeDescriptions: Record<ImportMode, string> = {
  dry_run: 'Revisa el archivo fila por fila y muestra el informe. No crea ningún registro.',
  commit_valid: 'Crea los registros de las filas válidas y deja un informe de las demás.',
  commit_all:
    'Crea los registros solo si todas las filas son válidas; si alguna no lo es, no crea ninguno.',
};
export const modeLabel = (code: string): string =>
  (modeLabels as Record<string, string>)[code] ?? 'Otro modo';
export const modeOrder: readonly ImportMode[] = ['dry_run', 'commit_valid', 'commit_all'];

export const statusPresentation: Record<ImportStatus, { label: string; tone: StatusTone }> = {
  running: { label: 'En curso', tone: 'notice' },
  validated: { label: 'Validada', tone: 'notice' },
  imported: { label: 'Importada', tone: 'success' },
  failed: { label: 'Fallida', tone: 'danger' },
};
export const statusOrder: readonly ImportStatus[] = ['running', 'validated', 'imported', 'failed'];

export const outcomePresentation: Record<ImportOutcome, { label: string; tone: StatusTone }> = {
  valid: { label: 'Válida', tone: 'success' },
  invalid: { label: 'Con error', tone: 'danger' },
  imported: { label: 'Importada', tone: 'success' },
  skipped: { label: 'Omitida', tone: 'neutral' },
};
export const outcomeOrder: readonly ImportOutcome[] = ['invalid', 'valid', 'imported', 'skipped'];

/** What went wrong in a row, in words. The columns at fault are listed next to it. */
export const codeLabels: Record<ImportRowCode, string> = {
  missing_value: 'Falta un valor obligatorio',
  invalid_value: 'El valor no es válido',
  formula_injection: 'Empieza con =, + , - o @ (se rechaza por seguridad)',
  duplicate: 'Ya existe un registro con el mismo valor',
  duplicate_in_file: 'Se repite dentro del archivo',
  invalid_area: 'El área no existe, es de otra empresa o está inactiva',
};
export const codeLabel = (code: string | null): string =>
  code === null ? '—' : ((codeLabels as Record<string, string>)[code] ?? 'Motivo no reconocido');

/** Names of the template columns (the technical names are what the file header must carry, shown next to them). */
export const columnLabels: Readonly<Record<string, string>> = {
  economicNumber: 'Número económico',
  plate: 'Placa',
  make: 'Marca',
  model: 'Modelo',
  year: 'Año',
  areaId: 'Área',
  odometerKm: 'Odómetro (km)',
  vin: 'VIN',
  registeredOn: 'Fecha de alta',
  kind: 'Tipo de empleado',
  firstName: 'Nombre',
  lastName: 'Apellidos',
  employeeNumber: 'Número de empleado',
  position: 'Puesto',
  hireDate: 'Fecha de ingreso',
  idType: 'Tipo de identificación',
  nationalId: 'Identificación',
  phone: 'Teléfono',
  email: 'Correo',
  licenseNumber: 'Número de licencia',
  licenseType: 'Tipo de licencia',
  licenseExpiresOn: 'Vencimiento de licencia',
};
export const columnLabel = (column: string): string => columnLabels[column] ?? column;

export const eventLabels: Record<ImportEvent['kind'], string> = {
  started: 'Iniciada',
  validated: 'Validada',
  imported: 'Importada',
  failed: 'Fallida',
};
export const eventLabel = (kind: string): string =>
  (eventLabels as Record<string, string>)[kind] ?? 'Cambio';
