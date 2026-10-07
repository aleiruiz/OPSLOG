import { AuthError } from '../../../domain/identity/src/index.js';

export const ROLE_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const HASH_PATTERN = /^[0-9a-f]{64}$/;
export const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const PERMISSION_PATTERN = /^[a-z][a-z_:]{0,63}$/;

export const lock = { mode: 'pessimistic_write' } as const;

export const nonBlank = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
export const isDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());
export const invalid = (): never => {
  throw new AuthError('invalid_input');
};

/** Rolls back an activation attempt that must be answered with `null` (same as the in-memory store). */
export class ActivationRejected extends AuthError {
  public constructor() {
    super('unauthorized');
  }
}
