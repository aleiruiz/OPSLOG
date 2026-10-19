import { createHash } from 'node:crypto';
import { MailError, type MailMessage, type MailPort, type SinkRecord } from './types.js';

export interface SinkOptions {
  /** Called once per message with the record; the address and the body never reach it. */
  readonly log?: (record: SinkRecord) => void;
  /** How many full messages to keep in memory for tests and demos (default none). */
  readonly retain?: number;
  readonly now?: () => Date;
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX_RECORDS = 500;

/** Digest that tells recipients apart inside one company without naming them. */
export function recipientRef(companyId: string, address: string): string {
  return createHash('sha256')
    .update(`${companyId.length}:${companyId}${address.trim().toLowerCase()}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * The default mail adapter: it sends nothing. It keeps a bounded list of records (company,
 * template, opaque recipient, result) and, only when asked, the last few full messages in memory.
 * A message with a key it has already seen is a duplicate and is not recorded twice.
 */
export class SinkMailAdapter implements MailPort {
  private readonly seen = new Set<string>();
  private readonly log: (record: SinkRecord) => void;
  private readonly retain: number;
  private readonly now: () => Date;
  public readonly records: SinkRecord[] = [];
  public readonly messages: MailMessage[] = [];

  public constructor(options: SinkOptions = {}) {
    this.log = options.log ?? (() => undefined);
    this.retain = options.retain ?? 0;
    this.now = options.now ?? (() => new Date());
  }

  public async send(message: MailMessage): Promise<void> {
    if (!ADDRESS.test(message.to)) throw new MailError('invalid_address');
    const key = `${message.companyId.length}:${message.companyId}${message.idempotencyKey}`;
    const duplicate = this.seen.has(key);
    this.seen.add(key);
    const record: SinkRecord = {
      companyId: message.companyId,
      template: message.template,
      recipient: recipientRef(message.companyId, message.to),
      idempotencyKey: message.idempotencyKey,
      result: duplicate ? 'duplicate' : 'accepted',
      at: this.now().toISOString(),
    };
    this.records.push(record);
    if (this.records.length > MAX_RECORDS) this.records.shift();
    this.log(record);
    if (duplicate || this.retain <= 0) return;
    this.messages.push(structuredClone(message));
    if (this.messages.length > this.retain) this.messages.shift();
  }
}
