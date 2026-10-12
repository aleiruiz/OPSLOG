import { WorkOrderError } from './errors.js';
import {
  PREVENTIVE_ORDER_ADOPTED_EVENT,
  PREVENTIVE_ORDER_CANCELLED_EVENT,
  PREVENTIVE_ORDER_CLOSED_EVENT,
  PREVENTIVE_ORDER_REOPENED_EVENT,
  WORK_ORDER_CREATED_EVENT,
  WORK_ORDER_STATUS_CHANGED_EVENT,
  type WorkOrderEvent,
} from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const id = (value: unknown) => typeof value === 'string' && ID.test(value);
const count = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;

/**
 * Allowlisted outbox payloads, checked before persistence. Status events carry only ids and the
 * version. The closure event is the accepted MNT-PLANS port: its consumer requires the real
 * service date and odometer (no PII, free text, evidence or cost ever travels).
 */
const SCHEMAS: Readonly<Record<string, Readonly<Record<string, (value: unknown) => boolean>>>> = {
  [WORK_ORDER_CREATED_EVENT]: { orderId: id, vehicleId: id, version: count },
  [WORK_ORDER_STATUS_CHANGED_EVENT]: { orderId: id, vehicleId: id, version: count },
  [PREVENTIVE_ORDER_CLOSED_EVENT]: {
    planId: id,
    occurrenceId: id,
    orderId: id,
    kind: (value) => value === 'preventive',
    completedAt: (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)),
    actualDate: (value) => typeof value === 'string' && DATE.test(value),
    actualKm: count,
    version: count,
  },
  ...Object.fromEntries(
    [
      PREVENTIVE_ORDER_REOPENED_EVENT,
      PREVENTIVE_ORDER_CANCELLED_EVENT,
      PREVENTIVE_ORDER_ADOPTED_EVENT,
    ].map((type) => [type, { planId: id, occurrenceId: id, orderId: id, version: count }]),
  ),
};

export function validateWorkOrderEvent(event: WorkOrderEvent): WorkOrderEvent {
  const schema = SCHEMAS[event.type];
  const keys = Object.keys(event.payload);
  if (
    !schema ||
    keys.length !== Object.keys(schema).length ||
    keys.some((key) => !schema[key]?.(event.payload[key]))
  )
    throw new WorkOrderError('invalid_input');
  return { type: event.type, payload: { ...event.payload } };
}
