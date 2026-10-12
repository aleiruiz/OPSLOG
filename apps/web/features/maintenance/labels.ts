import type { StatusTone } from '@opslog/ui';
import type {
  BffMoney,
  BffWorkOrderCommand,
  BffWorkOrderCost,
  BffWorkOrderFileCommand,
  BffWorkOrderStatus,
  BffWorkOrderTransition,
} from '@opslog/contracts';

/** Spanish labels for the English snake_case states of SPECS §6.1; always shown as text, not color only. */
export const STATUS_LABELS: Readonly<Record<BffWorkOrderStatus, string>> = {
  scheduled: 'Programada',
  assigned: 'Asignada',
  in_progress: 'En proceso',
  completed: 'Terminada',
  closed: 'Cerrada',
  cancelled: 'Cancelada',
};
export const STATUS_TONES: Readonly<Record<BffWorkOrderStatus, StatusTone>> = {
  scheduled: 'notice',
  assigned: 'notice',
  in_progress: 'warning',
  completed: 'warning',
  closed: 'success',
  cancelled: 'neutral',
};
export const KIND_LABELS = { preventive: 'Preventiva', corrective: 'Correctiva' } as const;
export const COMMAND_LABELS: Readonly<Record<BffWorkOrderCommand, string>> = {
  assign: 'Asignar',
  start: 'Iniciar trabajo',
  complete: 'Registrar término',
  approve_close: 'Aprobar cierre',
  close: 'Cerrar orden',
  cancel: 'Cancelar orden',
  reopen: 'Reabrir orden',
};
export const FILE_COMMAND_LABELS: Readonly<Record<BffWorkOrderFileCommand, string>> = {
  evidence_attached: 'Evidencia agregada',
  evidence_detached: 'Evidencia retirada',
  invoice_attached: 'Factura agregada',
  invoice_detached: 'Factura retirada',
};
/** Title of a timeline entry: a command with its resulting state, a file change, or the creation. */
export function historyTitle(entry: BffWorkOrderTransition): string {
  if (entry.command === 'create') return 'Orden registrada';
  if (entry.command in FILE_COMMAND_LABELS)
    return FILE_COMMAND_LABELS[entry.command as BffWorkOrderFileCommand];
  return `${COMMAND_LABELS[entry.command as BffWorkOrderCommand]} → ${STATUS_LABELS[entry.to]}`;
}
/** Stable requirement ids returned by MNT-ORDERS in `missingRequirements`. */
export const REQUIREMENT_LABELS: Readonly<Record<string, string>> = {
  responsibleId: 'Indica la persona responsable.',
  scheduledDate: 'Indica la fecha programada.',
  workshopOrMechanic: 'Elige un taller o un mecánico.',
  actualDate: 'Indica la fecha real del servicio.',
  actualKm: 'Indica el kilometraje del servicio.',
  tasks: 'Registra al menos un trabajo realizado.',
  vehicleStatus: 'Elige el estado del vehículo al cerrar.',
  closeApproval: 'Falta la aprobación de cierre de una persona supervisora.',
  noOtherOpenWorkshopOrders:
    'El vehículo tiene otra orden abierta en taller: no puede volver a Activo.',
  reason: 'Escribe el motivo.',
  evidence: 'Sube al menos una evidencia del trabajo (foto o documento).',
  invoice: 'Sube la factura del trabajo.',
};
export const requirementLabel = (id: string): string =>
  REQUIREMENT_LABELS[id] ?? 'Falta un requisito del flujo.';
export const VEHICLE_STATUS_LABELS = {
  active: 'Activo',
  restricted: 'Restringido',
  in_maintenance: 'En mantenimiento',
  out_of_service: 'Fuera de servicio',
  inactive: 'Inactivo',
} as const;
export const COST_CATEGORY_LABELS: Readonly<Record<BffWorkOrderCost['category'], string>> = {
  labor: 'Mano de obra',
  parts: 'Refacciones',
  external_service: 'Servicio externo',
  other: 'Otro',
};

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'CLP']);

/** Exact amount from minor units (decimal string), without floating point or rounding. */
export function formatMoney(money: BffMoney): string {
  const decimals = ZERO_DECIMAL.has(money.currency) ? 0 : 2;
  const digits = money.amountMinor.padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = decimals ? `.${digits.slice(-decimals)}` : '';
  return `${whole}${fraction} ${money.currency}`;
}

/** `2026-10-12` as `12/10/2026`; calendar dates stay calendar dates (no timezone shift). */
export const formatDate = (value: string | null): string =>
  value ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}` : 'Sin fecha';
export const formatKm = (value: number | null): string =>
  value === null ? 'Sin dato' : `${value.toLocaleString('es-MX')} km`;
