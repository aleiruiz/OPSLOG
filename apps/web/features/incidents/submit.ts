import { SubmitKeys } from '../maintenance/idempotency';
import type { Result } from '../../app/types';

/**
 * Sends a keyed command and, after a network failure, once more with the same key, so the server replays
 * the first result instead of applying the command twice (the same rule the maintenance screens follow).
 */
export async function sendKeyed<T>(
  keys: SubmitKeys,
  request: unknown,
  send: (key: string) => Promise<Result<T>>,
): Promise<Result<T>> {
  const key = keys.keyFor(request);
  let result = await send(key);
  if (!result.ok && result.error.code === 'network_error') result = await send(key);
  keys.settle(result);
  return result;
}

export { SubmitKeys };
