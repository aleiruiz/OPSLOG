import { JITTER, MAX_AUTOMATIC_ATTEMPTS, RETRY_DELAYS_MS } from './catalog.js';
import type { AttemptOutcome, Delivery } from './types.js';
import type { AttemptResult } from '../../../platform/webhooks/src/index.js';

/** Failures that will not improve by trying again: the destination itself is wrong or refused. */
const TERMINAL = new Set([
  'not_https',
  'credentials',
  'port',
  'host',
  'invalid_url',
  'private_address',
]);

/** 408 and 429 are asked again; every other 4xx is the receiver saying no. */
export function retryable(result: AttemptResult): boolean {
  if (result.failure === null) return false;
  if (TERMINAL.has(result.failure)) return false;
  if (result.failure === 'http' && result.status !== null)
    return (
      !(result.status >= 400 && result.status < 500) ||
      result.status === 408 ||
      result.status === 429
    );
  return true;
}

/** The delay before attempt number `attempts + 1`, ±20 % (`random` in [0, 1)). */
export function delayAfter(attempts: number, random: () => number): number {
  const base = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1] as number;
  return Math.round(base * (1 + (random() * 2 - 1) * JITTER));
}

/** The error code that is kept: what failed, never what the receiver answered. */
export function errorCode(result: AttemptResult): string {
  if (result.failure === 'http' && result.status !== null) return `http_${result.status}`;
  return result.failure ?? 'unknown';
}

/** What an attempt's result means for the delivery: delivered, retried later or dead-lettered. */
export function outcomeOf(
  delivery: Pick<Delivery, 'attempts' | 'manual'>,
  result: AttemptResult,
  now: Date,
  random: () => number,
): AttemptOutcome {
  const base = { statusCode: result.status, durationMs: result.durationMs };
  if (result.failure === null)
    return {
      kind: 'delivered',
      statusCode: result.status as number,
      durationMs: result.durationMs,
    };
  const attempts = delivery.attempts + 1;
  const error = errorCode(result);
  // A manual retry is one more attempt, not a new schedule; a terminal failure never repeats.
  if (delivery.manual || !retryable(result) || attempts >= MAX_AUTOMATIC_ATTEMPTS)
    return { kind: 'dead_letter', ...base, error };
  return {
    kind: 'retry',
    ...base,
    error,
    nextAttemptAt: new Date(now.getTime() + delayAfter(attempts, random)).toISOString(),
  };
}
