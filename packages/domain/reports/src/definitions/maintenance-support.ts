import { dayInZone } from '../calendar.js';
import { WORK_ORDER_STATUS_LABELS, optionsOf } from '../labels.js';
import type { WorkOrderFact } from '../ports-ops.js';
import { indexBy } from '../rows.js';
import type { ReportDefinition, ReportFilter } from '../types.js';

export const STATUS: ReportFilter = {
  id: 'status',
  label: 'Estado de la orden',
  kind: 'enum',
  options: optionsOf(WORK_ORDER_STATUS_LABELS),
  test: (row, value) => row['_status'] === value,
};

/** The day the work happened or was due; an order with none falls back to the day it was created. */
export const orderDay = (order: WorkOrderFact, timeZone: string): string =>
  order.actualDate ?? order.scheduledDate ?? dayInZone(new Date(order.createdAt), timeZone);

export async function names(
  ctx: Parameters<ReportDefinition['load']>[0],
  sources: Parameters<ReportDefinition['load']>[2],
) {
  const [vehicles, areas] = await Promise.all([
    sources.vehicles(ctx.tenantId),
    sources.areas(ctx.tenantId),
  ]);
  const areaById = indexBy(areas, (a) => a.id);
  return {
    vehicles,
    vehicleById: indexBy(vehicles, (v) => v.id),
    area: (areaId: string) => areaById.get(areaId)?.name ?? null,
  };
}
