/** What the rest of the platform may know about sending an e-mail. The provider stays behind this port. */
export interface MailMessage {
  readonly companyId: string;
  /** Recipient address. It goes to the provider and nowhere else: no log, audit or event keeps it. */
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string | undefined;
  /** Name of the template that produced the message (for the record of the sink, never a content). */
  readonly template: string;
  /** One value per message: a provider or a sink that sees it twice sends once. */
  readonly idempotencyKey: string;
}

export type MailFailure =
  | 'invalid_address'
  | 'rejected'
  | 'connection'
  | 'timeout'
  | 'auth'
  | 'unknown';

/** A refusal of the provider as a code. The provider's own message may hold addresses: it is dropped. */
export class MailError extends Error {
  public constructor(public readonly code: MailFailure) {
    super(`mail ${code}`);
    this.name = 'MailError';
  }
}

export interface MailPort {
  send(message: MailMessage): Promise<void>;
}

/** What the sink records of a message: company, template, an opaque recipient and the result. */
export interface SinkRecord {
  readonly companyId: string;
  readonly template: string;
  /** Digest of company and address: it tells two recipients apart without naming either. */
  readonly recipient: string;
  readonly idempotencyKey: string;
  readonly result: 'accepted' | 'duplicate';
  readonly at: string;
}

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly from: string;
}
