import { createTransport } from 'nodemailer';
import {
  MailError,
  type MailFailure,
  type MailMessage,
  type MailPort,
  type SmtpConfig,
} from './types.js';

/** The part of a nodemailer transport the adapter uses; tests inject their own. */
export interface SmtpTransport {
  sendMail(message: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string | undefined;
    messageId: string;
  }): Promise<unknown>;
}

export interface SmtpOptions {
  readonly config: SmtpConfig;
  /** Certificate authority to trust besides the system ones (a test server's own). */
  readonly ca?: string | Buffer;
  /** Starts the connection encrypted (port 465 style); otherwise STARTTLS is mandatory. */
  readonly implicitTls?: boolean;
  readonly timeoutMs?: number;
  readonly transport?: SmtpTransport;
}

const TIMEOUT_MS = 15_000;

/** Provider errors as codes; the message of an SMTP refusal can name an address, so it is dropped. */
export function failureOf(error: unknown): MailFailure {
  const code = (error as { code?: unknown } | null)?.code;
  const response = (error as { responseCode?: unknown } | null)?.responseCode;
  if (code === 'EAUTH') return 'auth';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return 'timeout';
  if (code === 'ECONNECTION' || code === 'ESOCKET' || code === 'ECONNREFUSED' || code === 'EDNS')
    return 'connection';
  if (code === 'EENVELOPE' || (typeof response === 'number' && response >= 500)) return 'rejected';
  return 'unknown';
}

/**
 * SMTP through nodemailer. TLS is not optional: port 465 (or `implicitTls`) connects encrypted, any
 * other port must upgrade with STARTTLS or the send fails, and the certificate is always verified.
 */
export class SmtpMailAdapter implements MailPort {
  private readonly transport: SmtpTransport;
  private readonly from: string;
  private readonly domain: string;

  public constructor(options: SmtpOptions) {
    const { config } = options;
    this.from = config.from;
    this.domain = config.from.slice(config.from.lastIndexOf('@') + 1);
    const implicit = options.implicitTls ?? config.port === 465;
    this.transport =
      options.transport ??
      createTransport({
        host: config.host,
        port: config.port,
        secure: implicit,
        requireTLS: !implicit,
        auth: { user: config.user, pass: config.password },
        tls: {
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          ...(options.ca ? { ca: options.ca } : {}),
        },
        connectionTimeout: options.timeoutMs ?? TIMEOUT_MS,
        greetingTimeout: options.timeoutMs ?? TIMEOUT_MS,
        socketTimeout: options.timeoutMs ?? TIMEOUT_MS,
      });
  }

  public async send(message: MailMessage): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
        // One id per message: a retry of the same notification carries the same Message-ID.
        messageId: `<${message.idempotencyKey.replace(/[^A-Za-z0-9._-]/g, '')}@${this.domain}>`,
      });
    } catch (error) {
      throw new MailError(failureOf(error));
    }
  }
}
