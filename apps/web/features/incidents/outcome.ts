import type { Result } from '../../app/types';
import { describeError, isStale } from './errors';
import type { SubmitOutcome } from './EventForm';

/**
 * Turns the answer of a write into what a form shows: success, or a neutral message and whether the
 * case moved on (a stale version). A 401 goes to the shared session handling.
 */
export function outcomeOf<T>(
  result: Result<T>,
  onExpired: () => void,
  onOk: (value: T) => void,
  action?: string,
): SubmitOutcome {
  if (result.ok) {
    onOk(result.value);
    return { ok: true };
  }
  if (result.error.status === 401) onExpired();
  return {
    ok: false,
    message: describeError(result.error, action),
    ...(isStale(result.error) ? { stale: true } : {}),
  };
}
