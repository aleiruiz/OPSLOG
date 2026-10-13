import type { Handler } from '../../base/src/index.js';
import {
  INCIDENT_SLA_ALERT_EVENT,
  INCIDENT_SLA_SCAN_EVENT,
  isOpaqueId,
  type AlertMessage,
  type IncidentAlertDelivery,
  type IncidentAlertMailer,
  type IncidentSlaScanner,
} from '../../../../packages/domain/incidents/sla/src/index.js';

export { INCIDENT_SLA_ALERT_EVENT, INCIDENT_SLA_SCAN_EVENT };
export const INCIDENT_ASSIGNED_EVENT = 'incident.assigned';

function exact(payload: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    throw new Error('invalid incident SLA job');
  const fields = payload as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !keys.includes(key)))
    throw new Error('invalid incident SLA job');
  return fields;
}

/**
 * Registers the SLA handlers on the shared durable outbox worker. The tenant always comes from the
 * claimed envelope; a payload that names one, or anything else unexpected, is refused and the
 * outbox retries it and then dead-letters it.
 */
export function registerIncidentSlaHandlers(
  worker: { register(type: string, handler: Handler): void },
  sla: { readonly scanner: IncidentSlaScanner; readonly delivery: IncidentAlertDelivery },
): void {
  worker.register(INCIDENT_SLA_SCAN_EVENT, async (payload, event) => {
    const job = exact(payload, ['incidentId']);
    const incidentId = job['incidentId'];
    if (incidentId !== undefined && !isOpaqueId(incidentId))
      throw new Error('invalid incident SLA job');
    await sla.scanner.scan(event.tenantId, incidentId);
  });
  worker.register(INCIDENT_ASSIGNED_EVENT, async (payload, event) => {
    const job = exact(payload, ['incidentId', 'version']);
    const { incidentId, version } = job;
    if (
      Object.keys(job).length !== 2 ||
      !isOpaqueId(incidentId) ||
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version < 1
    )
      throw new Error('invalid incident SLA job');
    await sla.scanner.onAssigned(event.tenantId, { incidentId, version });
  });
  worker.register(INCIDENT_SLA_ALERT_EVENT, async (payload, event) => {
    // The delivery validates the exact payload and throws while a recipient still awaits a retry.
    await sla.delivery.deliver(event.tenantId, payload);
  });
}

/**
 * The mail adapter outside production: it keeps the message in memory for tests and sends nothing,
 * over no network. It writes no log.
 */
export class TestSinkMailer implements IncidentAlertMailer {
  public readonly messages: AlertMessage[] = [];
  public async send(message: AlertMessage): Promise<void> {
    this.messages.push(structuredClone(message));
  }
}

/**
 * The mail port of the composition: the adapter given, or the test sink anywhere but production.
 * Production without a real adapter fails at start instead of dropping the mail.
 */
export function selectIncidentAlertMailer(options: {
  readonly environment?: string;
  readonly mailer?: IncidentAlertMailer;
}): IncidentAlertMailer {
  if (options.mailer) {
    if (options.environment === 'production' && options.mailer instanceof TestSinkMailer)
      throw new Error('The incident alert test sink cannot run in production');
    return options.mailer;
  }
  if (options.environment === 'production')
    throw new Error('A real incident alert mail adapter is required in production');
  return new TestSinkMailer();
}
