import { daysBetween } from '../calendar.js';
import { WORK_ORDER_STATUS_LABELS, label } from '../labels.js';
import { groupDigits, indexBy, onOrAfter, onOrBefore, vehicleLabel } from '../rows.js';
import type { ReportDefinition, Row } from '../types.js';
import { STATUS, names } from './maintenance-support.js';
import { AREA } from './period.js';

const PUNCTUALITY = {
  early: 'Anticipada',
  on_time: 'En fecha',
  late: 'Con retraso',
  overdue: 'Vencida sin atender',
  pending: 'Pendiente',
  no_target: 'Sin fecha objetivo',
} as const;

/** BRD §13.1 «Mantenimiento preventivo» plan vs. real: the deviation of each order from the plan's target. */
export const MAINTENANCE_PLAN_VS_ACTUAL: ReportDefinition = {
  id: 'maintenance_plan_vs_actual',
  family: 'maintenance',
  title: 'Mantenimiento preventivo: plan contra real',
  description: 'Órdenes preventivas con su fecha y kilometraje objetivo, lo realizado y el desvío.',
  view: 'view',
  columns: [
    { id: 'vehicle', label: 'Vehículo', kind: 'text' },
    { id: 'area', label: 'Área', kind: 'text' },
    { id: 'plan', label: 'Plan', kind: 'text' },
    { id: 'status', label: 'Estado de la orden', kind: 'text' },
    { id: 'targetDate', label: 'Fecha objetivo', kind: 'date' },
    { id: 'actualDate', label: 'Fecha real', kind: 'date' },
    { id: 'deviationDays', label: 'Desvío (días)', kind: 'integer' },
    { id: 'targetKm', label: 'Km objetivo', kind: 'integer' },
    { id: 'actualKm', label: 'Km real', kind: 'integer' },
    { id: 'deviationKm', label: 'Desvío (km)', kind: 'integer' },
    { id: 'punctuality', label: 'Cumplimiento', kind: 'text' },
  ],
  filters: [
    AREA,
    STATUS,
    {
      id: 'punctuality',
      label: 'Cumplimiento',
      kind: 'enum',
      options: Object.entries(PUNCTUALITY).map(([value, text]) => ({ value, label: text })),
      test: (row, value) => row['_punctuality'] === value,
    },
    {
      id: 'from',
      label: 'Objetivo desde',
      kind: 'date',
      test: (row, value) => onOrAfter(row['targetDate'], value),
    },
    {
      id: 'to',
      label: 'Objetivo hasta',
      kind: 'date',
      test: (row, value) => onOrBefore(row['targetDate'], value),
    },
  ],
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'targetDate', direction: 'desc' },
  async load(ctx, _needed, sources) {
    const [orders, plans, lookup] = await Promise.all([
      sources.workOrders(ctx, { withCosts: false }),
      sources.plans(ctx),
      names(ctx, sources),
    ]);
    const planById = indexBy(plans, (p) => p.id);
    const rows: Row[] = [];
    for (const order of orders) {
      if (order.kind !== 'preventive' || order.planId === null || order.status === 'cancelled')
        continue;
      const vehicle = lookup.vehicleById.get(order.vehicleId);
      if (!vehicle) continue;
      const plan = planById.get(order.planId);
      const target = order.targetDate ?? order.scheduledDate;
      const days =
        order.actualDate !== null && target !== null ? daysBetween(target, order.actualDate) : null;
      const km =
        order.actualKm !== null && order.targetKm !== null ? order.actualKm - order.targetKm : null;
      const punctuality =
        order.actualDate !== null
          ? days === null
            ? 'no_target'
            : days < 0
              ? 'early'
              : days === 0
                ? 'on_time'
                : 'late'
          : target !== null && target < ctx.today
            ? 'overdue'
            : 'pending';
      const interval = [
        plan?.intervalDays ? `cada ${plan.intervalDays} días` : null,
        plan?.intervalKm ? `cada ${groupDigits(plan.intervalKm)} km` : null,
      ].filter((part) => part !== null);
      rows.push({
        vehicle: vehicleLabel(vehicle),
        area: lookup.area(vehicle.areaId),
        plan: interval.length > 0 ? interval.join(' / ') : null,
        status: label(WORK_ORDER_STATUS_LABELS, order.status),
        targetDate: target,
        actualDate: order.actualDate,
        deviationDays: days,
        targetKm: order.targetKm,
        actualKm: order.actualKm,
        deviationKm: km,
        punctuality: PUNCTUALITY[punctuality],
        _areaId: vehicle.areaId,
        _status: order.status,
        _punctuality: punctuality,
      });
    }
    return rows;
  },
};
