import type { BffIncident, BffRepairLinkChange, BffWorkOrder } from '@opslog/contracts';
import type { Result } from '../../app/types';
import { ORDER_STATUS_LABELS } from './labelsCosts';
import { sendKeyed, type SubmitKeys } from './submit';
import type { IncidentPorts } from './ports';
import { formatDateTime } from './time';

/** Corrective, live orders of the case's vehicle that no link of this case already holds, by name. */
export function linkableOrders(
  orders: readonly BffWorkOrder[],
  incident: BffIncident,
  linkedOrderIds: readonly string[],
): readonly BffWorkOrder[] {
  return orders
    .filter(
      (order) =>
        order.kind === 'corrective' &&
        order.vehicleId === incident.vehicle.id &&
        order.status !== 'cancelled' &&
        !linkedOrderIds.includes(order.id),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** How an order reads in a choice: what it is for, its state and when it was registered. Never its id. */
export function orderLabel(order: BffWorkOrder, zone: string): string {
  const what = order.description?.trim()
    ? order.description.trim()
    : 'Orden correctiva sin descripción';
  return `${what} · ${ORDER_STATUS_LABELS[order.status]} · registrada el ${formatDateTime(order.createdAt, zone)}`;
}

/** The description a new corrective order starts with: the case it repairs, by folio. */
export const defaultOrderDescription = (incident: BffIncident): string =>
  `Reparación del siniestro ${incident.folio}`;

/** Links an order with its own `Idempotency-Key`; a retry of the same request replays the first answer. */
export function linkOrder(
  ports: IncidentPorts,
  keys: SubmitKeys,
  incident: BffIncident,
  orderId: string,
): Promise<Result<BffRepairLinkChange>> {
  const body = { version: incident.version, orderId };
  return sendKeyed(keys, [incident.id, 'link', body], (key) =>
    ports.repairs.link(incident.id, body, key),
  );
}
