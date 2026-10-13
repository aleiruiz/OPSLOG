import { IncidentError } from './errors.js';
import { INCIDENT_STATUSES } from './catalog.js';
import {
  INCIDENT_ASSIGNED_EVENT,
  INCIDENT_CANCELLED_EVENT,
  INCIDENT_CLOSED_EVENT,
  INCIDENT_COSTS_CHANGED_EVENT,
  INCIDENT_CREATED_EVENT,
  INCIDENT_REPAIR_LINKED_EVENT,
  INCIDENT_REPAIR_UNLINKED_EVENT,
  INCIDENT_REOPENED_EVENT,
  INCIDENT_STATUS_CHANGED_EVENT,
  INCIDENT_UPDATED_EVENT,
  type IncidentEvent,
} from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const id = (value: unknown) => typeof value === 'string' && ID.test(value);
const count = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;

/** Exact outbox payloads, checked before persistence: ids and the version, never text, PII or amounts. */
const SCHEMAS: Readonly<Record<string, Readonly<Record<string, (value: unknown) => boolean>>>> = {
  [INCIDENT_CREATED_EVENT]: { incidentId: id, vehicleId: id, version: count },
  [INCIDENT_UPDATED_EVENT]: { incidentId: id, version: count },
  // INC-WORKFLOW (SPECS §7): the status is an enum value, never a reason, a name or an amount.
  [INCIDENT_STATUS_CHANGED_EVENT]: {
    incidentId: id,
    vehicleId: id,
    version: count,
    status: (value) => (INCIDENT_STATUSES as readonly unknown[]).includes(value),
  },
  [INCIDENT_ASSIGNED_EVENT]: { incidentId: id, version: count },
  [INCIDENT_CANCELLED_EVENT]: { incidentId: id, version: count },
  [INCIDENT_CLOSED_EVENT]: { incidentId: id, vehicleId: id, version: count },
  [INCIDENT_REOPENED_EVENT]: { incidentId: id, version: count, cycle: count },
  [INCIDENT_COSTS_CHANGED_EVENT]: { incidentId: id, version: count },
  [INCIDENT_REPAIR_LINKED_EVENT]: { incidentId: id, orderId: id, version: count },
  [INCIDENT_REPAIR_UNLINKED_EVENT]: { incidentId: id, orderId: id, version: count },
};

export function validateIncidentEvent(event: IncidentEvent): IncidentEvent {
  const schema = SCHEMAS[event.type];
  const keys = Object.keys(event.payload);
  if (
    !schema ||
    keys.length !== Object.keys(schema).length ||
    keys.some((key) => !schema[key]?.(event.payload[key]))
  )
    throw new IncidentError('invalid_input');
  return { type: event.type, payload: { ...event.payload } };
}
