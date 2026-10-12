import type { BffWorkOrder, BffWorkOrderTransitionInput } from '@opslog/contracts';
import type { MaintenancePorts, Result } from './ports';

/** A fresh Idempotency-Key (8-128 of [A-Za-z0-9_-]): a random UUID, or random hex without `randomUUID`. */
export function newSubmitKey(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * One key per user submit attempt. Submitting the same request again (a retry after a network error or
 * a repeated click) reuses the key, so the server replays the first result instead of applying the
 * command twice; any edit changes the request and therefore takes a new key. A key is dropped once the
 * server answered definitively (a result or a 4xx rejection), never after a network or server failure,
 * where the outcome of the first attempt is unknown.
 */
export class SubmitKeys {
  private current: { readonly fingerprint: string; readonly key: string } | null = null;
  public constructor(private readonly generate: () => string = newSubmitKey) {}

  public keyFor(request: unknown): string {
    const fingerprint = JSON.stringify(request);
    if (this.current?.fingerprint !== fingerprint)
      this.current = { fingerprint, key: this.generate() };
    return this.current.key;
  }

  public settle(result: Result<unknown>): void {
    if (result.ok || result.error.status < 500) this.current = null;
  }
}

const isNetworkFailure = (result: Result<unknown>): boolean =>
  !result.ok && result.error.code === 'network_error';

/** Sends the command with its key and, after a network failure, once more with the same key. */
export async function submitTransition(
  ports: MaintenancePorts,
  keys: SubmitKeys,
  orderId: string,
  body: BffWorkOrderTransitionInput,
): Promise<Result<BffWorkOrder>> {
  const key = keys.keyFor([orderId, body]);
  let result = await ports.orders.transition(orderId, body, key);
  if (isNetworkFailure(result)) result = await ports.orders.transition(orderId, body, key);
  keys.settle(result);
  return result;
}
