import { createHash } from 'node:crypto';
import { IncidentError } from '../../cases/src/index.js';
import { isAlertKind, type AlertKind } from './catalog.js';
import type { NewAlert, SlaAlert } from './types.js';

/** The one outbox event of this package (SPECS §7): ids, the kind and the cycle, nothing else. */
export const INCIDENT_SLA_ALERT_EVENT = 'incident.sla_alert';
/** Jobs the worker accepts; the tenant always comes from the claimed envelope, never the payload. */
export const INCIDENT_SLA_SCAN_EVENT = 'incident.sla.scan';

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const isOpaqueId = (value: unknown): value is string =>
  typeof value === 'string' && ID.test(value);

export interface SlaAlertPayload {
  readonly incidentId: string;
  readonly alertId: string;
  readonly kind: AlertKind;
  readonly cycle: number;
}

/** Exact payload, checked before persistence and again when the worker consumes it. */
export function parseSlaAlertPayload(value: unknown): SlaAlertPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new IncidentError('invalid_input');
  const fields = value as Readonly<Record<string, unknown>>;
  const { incidentId, alertId, kind, cycle } = fields;
  if (
    Object.keys(fields).length !== 4 ||
    !isOpaqueId(incidentId) ||
    !isOpaqueId(alertId) ||
    !isAlertKind(kind) ||
    typeof cycle !== 'number' ||
    !Number.isInteger(cycle) ||
    cycle < 1
  )
    throw new IncidentError('invalid_input');
  return { incidentId, alertId, kind, cycle };
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
/** The id follows the unique key, so two workers that race on one notice name the same row. */
export const alertIdOf = (
  alert: Pick<NewAlert, 'tenantId' | 'incidentId' | 'cycle' | 'kind' | 'dedupeRef'>,
): string =>
  `sla-${digest(JSON.stringify([alert.tenantId, alert.incidentId, alert.cycle, alert.kind, alert.dedupeRef]))}`;
export const alertEventOf = (alert: SlaAlert) => ({
  type: INCIDENT_SLA_ALERT_EVENT,
  payload: {
    incidentId: alert.incidentId,
    alertId: alert.id,
    kind: alert.kind,
    cycle: alert.cycle,
  },
});
