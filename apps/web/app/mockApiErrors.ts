import type { ApiError } from '@opslog/contracts';
import type { Permission, Result } from './types';

let correlation = 0;
/** Uniform error body of the BFF: a code, the status and a generic message; no per-field detail. */
export function apiError(status: ApiError['status'], code: string, message: string): Result<never> {
  correlation += 1;
  const error: ApiError = { code, status, message, correlationId: `corr-mock-${correlation}` };
  return { ok: false, error };
}
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const badRequest = () => apiError(400, 'bad_request', 'Invalid request');

const PII_KEYS = ['nationalId', 'idType', 'phone', 'email', 'licenseNumber'];

/** Writing personal data needs `view_pii` on top of the operation's own permission (like the server). */
export const withPii = (base: Permission, input: unknown): readonly Permission[] =>
  typeof input === 'object' &&
  input !== null &&
  !Array.isArray(input) &&
  PII_KEYS.some((key) => Object.hasOwn(input, key))
    ? [base, 'view_pii']
    : [base];
