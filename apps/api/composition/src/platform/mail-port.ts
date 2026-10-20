import type {
  AlertMessage,
  IncidentAlertMailer,
} from '../../../../../packages/domain/incidents/sla/src/index.js';
import { SinkMailAdapter, type MailPort } from '../../../../../packages/platform/mail/src/index.js';
import type { PlatformAdapters } from './types.js';

/**
 * The mail port of the platform: the adapter given, or the sink (ADR-0016: the default sends nothing).
 * INC-SLA keeps its own production guard (`selectIncidentAlertMailer`), which refuses to start
 * without a real mailer.
 */
export function selectMail(adapters: PlatformAdapters): MailPort {
  return adapters.mail ?? new SinkMailAdapter();
}

/**
 * INC-SLA's mailer as an adapter of the general port (ADR-0016): the same message, one per notice
 * and recipient, now through the port every module shares. The key makes a retry send once.
 */
export class MailPortAlertMailer implements IncidentAlertMailer {
  public constructor(private readonly port: MailPort) {}
  public send(message: AlertMessage): Promise<void> {
    return this.port.send({
      companyId: message.tenantId,
      to: message.to,
      subject: message.subject,
      text: message.body,
      template: 'incident_sla',
      idempotencyKey: `sla:${message.alertId}:${message.recipientId}`,
    });
  }
}
