/** Seconds a client is told to wait before repeating a request that hit a saturated pool. */
export const UNAVAILABLE_RETRY_AFTER_SECONDS = 2;

const SATURATION_CODES: ReadonlySet<string> = new Set(['POOL_ENQUEUELIMIT', 'POOL_ACQUIRETIMEOUT']);
const SATURATION_MESSAGE =
  /queue limit reached|timeout acquiring connection|acquire(?:d)? connection timeout|acquire timeout/i;

/**
 * Whether a failure is a saturated database pool (mysql2 "Queue limit reached." or a pool acquire
 * timeout), also when a driver wraps it (`driverError`, `cause`). It is load, not a defect: callers
 * answer 503 so the client retries. Only the code and the message are read; nothing is echoed.
 */
export function isPoolSaturation(error: unknown, depth = 0): boolean {
  if (typeof error !== 'object' || error === null || depth > 3) return false;
  const { code, message, driverError, cause } = error as Record<string, unknown>;
  if (typeof code === 'string' && SATURATION_CODES.has(code)) return true;
  if (typeof message === 'string' && SATURATION_MESSAGE.test(message)) return true;
  return isPoolSaturation(driverError, depth + 1) || isPoolSaturation(cause, depth + 1);
}
