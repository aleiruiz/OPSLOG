import {
  parseDestination,
  resolvePublic,
  UrlRejected,
  systemResolver,
  type Resolver,
  type UrlRejection,
} from './guard.js';
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signatureHeader,
} from './signature.js';
import { httpsTransport, TransportError, type Transport } from './transport.js';

export const REQUEST_TIMEOUT_MS = 10_000;

export interface WebhookRequest {
  readonly url: string;
  readonly eventId: string;
  /** The exact bytes that are signed and sent. */
  readonly body: Uint8Array;
  /** Current secret first; the previous one too while its grace period lasts. */
  readonly secrets: readonly string[];
  /** Unix seconds of this attempt. */
  readonly timestamp: number;
}

export type AttemptFailure = UrlRejection | 'redirect' | 'timeout' | 'connection' | 'tls' | 'http';

/** The outcome of one attempt. `status` is the receiver's code; the body of its answer is never kept. */
export interface AttemptResult {
  readonly status: number | null;
  readonly durationMs: number;
  /** `null` for a 2xx. */
  readonly failure: AttemptFailure | null;
}

export interface SafeWebhookClientOptions {
  readonly resolve?: Resolver;
  readonly transport?: Transport;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

/**
 * Sends a signed POST to a public HTTPS destination (SPECS §4.3). The guard runs here, on every
 * attempt, not only at registration: a name that now resolves to a private address is refused
 * before any connection is opened (DNS rebinding). The connection is made to the address that was
 * validated, so DNS is not asked twice; redirects are never followed (a 3xx is a failure).
 */
export class SafeWebhookClient {
  private readonly resolve: Resolver;
  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  public constructor(options: SafeWebhookClientOptions = {}) {
    this.resolve = options.resolve ?? systemResolver;
    this.transport = options.transport ?? httpsTransport();
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  public async send(input: WebhookRequest): Promise<AttemptResult> {
    const started = this.now();
    const elapsed = () => Math.max(0, this.now() - started);
    let target;
    let address;
    try {
      target = parseDestination(input.url);
      address = await resolvePublic(target.hostname, this.resolve);
    } catch (error) {
      const code = error instanceof UrlRejected ? error.code : 'connection';
      return { status: null, durationMs: elapsed(), failure: code };
    }
    const timestamp = String(input.timestamp);
    try {
      const response = await this.transport({
        address: address.address,
        family: address.family,
        hostname: target.hostname,
        path: `${target.url.pathname}${target.url.search}`,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'OPSLOG-Webhooks/1',
          [EVENT_ID_HEADER]: input.eventId,
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: signatureHeader(input.secrets, timestamp, input.eventId, input.body),
        },
        body: input.body,
        timeoutMs: this.timeoutMs,
      });
      const { status } = response;
      if (status >= 200 && status < 300) return { status, durationMs: elapsed(), failure: null };
      return {
        status,
        durationMs: elapsed(),
        failure: status >= 300 && status < 400 ? 'redirect' : 'http',
      };
    } catch (error) {
      const code = error instanceof TransportError ? error.code : 'connection';
      return { status: null, durationMs: elapsed(), failure: code };
    }
  }
}
