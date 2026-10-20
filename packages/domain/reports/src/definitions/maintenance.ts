import { dayInZone, daysBetween } from '../calendar.js';
import { WORK_ORDER_KIND_LABELS, WORK_ORDER_STATUS_LABELS, label, optionsOf } from '../labels.js';
import { decimalNumber, moneyText, sumByCurrency } from '../money.js';
import type { WorkOrderFact } from '../ports-ops.js';
import {
  APPLIED,
  containsText,
  groupBy,
  inPeriod,
  onOrAfter,
  onOrBefore,
  round,
  textFilter,
  vehicleLabel,
} from '../rows.js';
import type { ReportDefinition, ReportFilter, Row } from '../types.js';
import { STATUS, names, orderDay } from './maintenance-support.js';
import { AREA, FROM, TO } from './period.js';

/** BRD §13.1 «Mantenimiento correctivo». The cost is financial data and the origin case shows by folio. */
export const MAINTENANCE_CORRECTIVE: ReportDefinition = {
  id: 'maintenance_corrective',
  family: 'maintenance',
  title: 'Mantenimiento correctivo',
  description: 'Órdenes correctivas con su taller, estado, duración, costo e incidente de origen.',
  view: 'view',
  columns: [
    { id: 'vehicle', label: 'Vehículo', kind: 'text' },
    { id: 'area', label: 'Área', kind: 'text' },
    { id: 'status', label: 'Estado de la orden', kind: 'text' },
    { id: 'description', label: 'Descripción', kind: 'text' },
    { id: 'workshop', label: 'Taller', kind: 'text' },
    { id: 'createdOn', label: 'Creada', kind: 'date' },
    { id: 'workDate', label: 'Fecha del trabajo', kind: 'date' },
    { id: 'closedOn', label: 'Cerrada', kind: 'date' },
    { id: 'daysOpen', label: 'Días abierta', kind: 'integer' },
    { id: 'reopenCount', label: 'Reaperturas', kind: 'integer' },
    { id: 'incident', label: 'Incidente de origen', kind: 'text' },
    { id: 'cost', label: 'Costo por moneda', kind: 'text', sensitivity: 'costs' },
  ],
  filters: [
    AREA,
    STATUS,
    {
      id: 'origin',
      label: 'Origen',
      kind: 'enum',
      options: [
        { value: 'incident', label: 'Con incidente de origen' },
        { value: 'none', label: 'Sin incidente' },
      ],
      test: (row, value) => (row['incident'] !== null) === (value === 'incident'),
    },
    {
      id: 'workshop',
      label: 'Taller (contiene)',
      kind: 'text',
      test: (row, value) => containsText(row['workshop'], value),
    },
    {
      id: 'from',
      label: 'Creada desde',
      kind: 'date',
      test: (row, value) => onOrAfter(row['createdOn'], value),
    },
    {
      id: 'to',
      label: 'Creada hasta',
      kind: 'date',
      test: (row, value) => onOrBefore(row['createdOn'], value),
    },
  ],
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'createdOn', direction: 'desc' },
  async load(ctx, needed, sources) {
    const [orders, lookup] = await Promise.all([
      sources.workOrders(ctx, { withCosts: needed.has('cost') }),
      names(ctx, sources),
    ]);
    const rows: Row[] = [];
    for (const order of orders) {
      if (order.kind !== 'corrective') continue;
      const vehicle = lookup.vehicleById.get(order.vehicleId);
      if (!vehicle) continue;
      const createdOn = dayInZone(new Date(order.createdAt), ctx.timeZone);
      const closedOn = order.closedAt ? dayInZone(new Date(order.closedAt), ctx.timeZone) : null;
      rows.push({
        vehicle: vehicleLabel(vehicle),
        area: lookup.area(vehicle.areaId),
        status: label(WORK_ORDER_STATUS_LABELS, order.status),
        description: order.description,
        workshop: order.workshop,
        createdOn,
        workDate: order.actualDate,
        closedOn,
        daysOpen:
          order.status === 'cancelled' ? null : daysBetween(createdOn, closedOn ?? ctx.today),
        reopenCount: order.reopenCount,
        incident: order.incidentFolio,
        cost: moneyText(order.costs ?? []),
        _areaId: vehicle.areaId,
        _status: order.status,
      });
    }
    return rows;
  },
};

type CostCategory = 'labor' | 'parts' | 'external_service' | 'other';

/** The orders of the period whose work is done: completed or closed, counted on the day of the work. */
function doneInPeriod(
  orders: readonly WorkOrderFact[],
  filters: ReadonlyMap<string, string | number>,
  timeZone: string,
): WorkOrderFact[] {
  const kind = textFilter(filters, 'kind');
  return orders.filter(
    (order) =>
      (order.status === 'completed' || order.status === 'closed') &&
      (kind === undefined || order.kind === kind) &&
      inPeriod(
        order.actualDate ?? (order.closedAt ? dayInZone(new Date(order.closedAt), timeZone) : null),
        filters,
      ),
  );
}

const KIND_FILTER: ReportFilter = {
  id: 'kind',
  label: 'Tipo de mantenimiento',
  kind: 'enum',
  options: optionsOf(WORK_ORDER_KIND_LABELS),
  test: APPLIED,
};

/**
 * BRD §13.1 «Costos de mantenimiento»: one row per vehicle and currency, never added across
 * currencies. The cost per km needs two readings of the odometer that really advanced.
 */
export const MAINTENANCE_COSTS: ReportDefinition = {
  id: 'maintenance_costs',
  family: 'maintenance',
  title: 'Costos de mantenimiento',
  description: 'Costo de las órdenes terminadas por vehículo y moneda, con costo por kilómetro.',
  view: 'view_costs',
  columns: [
    { id: 'vehicle', label: 'Vehículo', kind: 'text' },
    { id: 'area', label: 'Área', kind: 'text' },
    { id: 'currency', label: 'Moneda', kind: 'text', sensitivity: 'costs' },
    { id: 'orders', label: 'Órdenes', kind: 'integer' },
    { id: 'labor', label: 'Mano de obra', kind: 'number', sensitivity: 'costs' },
    { id: 'parts', label: 'Refacciones', kind: 'number', sensitivity: 'costs' },
    { id: 'externalService', label: 'Servicio externo', kind: 'number', sensitivity: 'costs' },
    { id: 'other', label: 'Otros', kind: 'number', sensitivity: 'costs' },
    { id: 'total', label: 'Total', kind: 'number', sensitivity: 'costs' },
    { id: 'kmSpan', label: 'Km recorridos entre órdenes', kind: 'integer' },
    { id: 'costPerKm', label: 'Costo por km', kind: 'number', sensitivity: 'costs' },
  ],
  filters: [AREA, KIND_FILTER, FROM, TO],
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'vehicle', direction: 'asc' },
  async load(ctx, _needed, sources, filters) {
    const [all, lookup] = await Promise.all([
      sources.workOrders(ctx, { withCosts: true }),
      names(ctx, sources),
    ]);
    const rows: Row[] = [];
    for (const [vehicleId, orders] of groupBy(
      doneInPeriod(all, filters, ctx.timeZone),
      (o) => o.vehicleId,
    )) {
      const vehicle = lookup.vehicleById.get(vehicleId);
      if (!vehicle) continue;
      const readings = orders
        .map((o) => o.actualKm)
        .filter((km): km is number => km !== null && Number.isFinite(km) && km >= 0);
      // Two readings that did not advance prove nothing: no cost per km.
      const span = readings.length >= 2 ? Math.max(...readings) - Math.min(...readings) : 0;
      const lines = orders.flatMap((o) => o.costs ?? []);
      for (const { currency, amountMinor } of sumByCurrency(lines)) {
        const mine = lines.filter((line) => line.currency === currency);
        const category = (name: CostCategory): number =>
          decimalNumber(
            sumByCurrency(mine.filter((line) => line.category === name)).at(0)?.amountMinor ?? '0',
            currency,
          );
        const total = decimalNumber(amountMinor, currency);
        rows.push({
          vehicle: vehicleLabel(vehicle),
          area: lookup.area(vehicle.areaId),
          currency,
          orders: orders.filter((o) => (o.costs ?? []).some((c) => c.currency === currency)).length,
          labor: category('labor'),
          parts: category('parts'),
          externalService: category('external_service'),
          other: category('other'),
          total,
          kmSpan: span > 0 ? span : null,
          costPerKm: span > 0 ? round(total / span, 4) : null,
          _areaId: vehicle.areaId,
        });
      }
    }
    return rows;
  },
};

/** BRD §13.1 «Frecuencia»: how often each vehicle goes to the workshop and the interval between visits. */
export const MAINTENANCE_FREQUENCY: ReportDefinition = {
  id: 'maintenance_frequency',
  family: 'maintenance',
  title: 'Frecuencia de mantenimiento',
  description: 'Órdenes por vehículo en el período, última visita e intervalo medio entre ellas.',
  view: 'view',
  columns: [
    { id: 'vehicle', label: 'Vehículo', kind: 'text' },
    { id: 'area', label: 'Área', kind: 'text' },
    { id: 'orders', label: 'Órdenes', kind: 'integer' },
    { id: 'preventive', label: 'Preventivas', kind: 'integer' },
    { id: 'corrective', label: 'Correctivas', kind: 'integer' },
    { id: 'lastOn', label: 'Última visita', kind: 'date' },
    { id: 'daysSinceLast', label: 'Días desde la última', kind: 'integer' },
    { id: 'avgDaysBetween', label: 'Intervalo medio (días)', kind: 'number' },
    { id: 'avgKmBetween', label: 'Intervalo medio (km)', kind: 'integer' },
  ],
  filters: [AREA, FROM, TO],
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'orders', direction: 'desc' },
  async load(ctx, _needed, sources, filters) {
    const [all, lookup] = await Promise.all([
      sources.workOrders(ctx, { withCosts: false }),
      names(ctx, sources),
    ]);
    const mine = groupBy(
      all.filter((o) => o.status !== 'cancelled' && inPeriod(orderDay(o, ctx.timeZone), filters)),
      (o) => o.vehicleId,
    );
    return lookup.vehicles.map((vehicle): Row => {
      const orders = mine.get(vehicle.id) ?? [];
      const done = orders
        .filter((o) => o.actualDate !== null)
        .sort((a, b) => (a.actualDate as string).localeCompare(b.actualDate as string));
      const last = done.at(-1)?.actualDate ?? null;
      const gaps = done
        .slice(1)
        .map((o, i) =>
          daysBetween((done[i] as WorkOrderFact).actualDate as string, o.actualDate as string),
        );
      const kmGaps = done
        .slice(1)
        .map((o, i) => (o.actualKm ?? NaN) - ((done[i] as WorkOrderFact).actualKm ?? NaN))
        .filter((km) => Number.isFinite(km) && km > 0);
      const mean = (xs: readonly number[]): number | null =>
        xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
      const avgDays = mean(gaps);
      const avgKm = mean(kmGaps);
      return {
        vehicle: vehicleLabel(vehicle),
        area: lookup.area(vehicle.areaId),
        orders: orders.length,
        preventive: orders.filter((o) => o.kind === 'preventive').length,
        corrective: orders.filter((o) => o.kind === 'corrective').length,
        lastOn: last,
        daysSinceLast: last === null ? null : Math.max(0, daysBetween(last, ctx.today)),
        avgDaysBetween: avgDays === null ? null : round(avgDays, 1),
        avgKmBetween: avgKm === null ? null : Math.round(avgKm),
        _areaId: vehicle.areaId,
      };
    });
  },
};
