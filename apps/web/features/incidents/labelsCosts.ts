import type {
  BffCostCategory,
  BffCostKind,
  BffIncidentAlertKind,
  BffIncidentSlaState,
  BffPolicyDeductible,
} from '@opslog/contracts';
import type { StatusTone } from '@opslog/ui';
import { STATUS_LABELS as ORDER_STATUS_LABELS } from '../maintenance/labels';
import { formatMinor } from './money';

export { ORDER_STATUS_LABELS };

/** Spanish labels of the repair, cost and SLA vocabulary (INC-COSTS and INC-SLA ids), always text and never colour alone. */
export const COST_KIND_LABELS: Readonly<Record<BffCostKind, string>> = {
  expense: 'Gasto',
  recovery: 'Recuperación',
};
export const EXPENSE_LABELS: Readonly<Record<string, string>> = {
  repair: 'Reparación sin orden',
  deductible: 'Deducible',
  towing: 'Grúa',
  fine: 'Multa',
  third_party_damage: 'Daños a terceros',
  legal: 'Gastos legales',
  other: 'Otro gasto',
};
export const RECOVERY_LABELS: Readonly<Record<string, string>> = {
  insurer: 'Pago de la aseguradora',
  third_party: 'Pago de un tercero',
  other: 'Otra recuperación',
};
export const categoryLabel = (kind: BffCostKind, category: BffCostCategory): string =>
  (kind === 'expense' ? EXPENSE_LABELS : RECOVERY_LABELS)[category] ?? 'Otro';

export const SLA_LABELS: Readonly<Record<BffIncidentSlaState, string>> = {
  not_started: 'SLA sin iniciar',
  on_track: 'SLA en tiempo',
  warning: 'SLA por vencer',
  breached: 'SLA vencido',
  met: 'SLA cumplido',
  missed: 'SLA incumplido',
};
export const SLA_TONES: Readonly<Record<BffIncidentSlaState, StatusTone>> = {
  not_started: 'neutral',
  on_track: 'success',
  warning: 'warning',
  breached: 'danger',
  met: 'success',
  missed: 'danger',
};

export const ALERT_LABELS: Readonly<
  Record<BffIncidentAlertKind, { label: string; tone: StatusTone; detail: string }>
> = {
  assigned: { label: 'Caso asignado', tone: 'notice', detail: 'Te asignaron este caso.' },
  sla_warning: {
    label: 'SLA por vencer',
    tone: 'warning',
    detail: 'El caso ya usó el 80 % de su plazo.',
  },
  sla_breach: {
    label: 'SLA vencido',
    tone: 'danger',
    detail: 'El caso pasó su plazo de resolución.',
  },
  unassigned: {
    label: 'Sin responsable',
    tone: 'warning',
    detail: 'El caso lleva más de 4 horas reportado sin responsable.',
  },
  unassigned_escalation: {
    label: 'Sin responsable (escalado)',
    tone: 'danger',
    detail: 'El caso lleva 24 horas o más sin responsable.',
  },
  inactive: {
    label: 'Sin movimiento',
    tone: 'warning',
    detail: 'El caso no ha tenido cambios en los días configurados.',
  },
  inactive_escalation: {
    label: 'Sin movimiento (escalado)',
    tone: 'danger',
    detail: 'El caso lleva el doble de días configurados sin cambios.',
  },
};

/** The deductible as insurance keeps it: an amount, or a percentage that is never turned into an amount. */
export function deductibleText(deductible: BffPolicyDeductible): string {
  if (deductible.kind === 'amount') return formatMinor(deductible.amountMinor, deductible.currency);
  const whole = Math.floor(deductible.basisPoints / 100);
  const rest = deductible.basisPoints % 100;
  return `${rest === 0 ? whole : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}`} % del monto reclamado`;
}
