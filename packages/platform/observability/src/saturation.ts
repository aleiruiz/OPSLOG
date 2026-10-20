/** Seconds a client is told to wait before repeating a request that hit a saturated pool. */
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 2;

// What mysql2 3.22 emits when the pool queue is full (`lib/base/pool.js`): an Error without code.
const SATURATION_MESSAGE = /^Queue limit reached\.$/;

/**
 * Whether a failure is a saturated database pool (the mysql2 "Queue limit reached." error), also when a driver wraps it (`driverError`, `cause`). It is load, not a defect: callers
 * answer 503 so the client retries. Only the message is read; nothing is echoed.
 */
export function isPoolSaturation(error: unknown, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > 3) return false;
  const { message, driverError, cause } = error as Record<string, unknown>;
  if (typeof message === 'string' && SATURATION_MESSAGE.test(message)) return true;
  return isPoolSaturation(driverError, depth + 1) || isPoolSaturation(cause, depth + 1);
}
