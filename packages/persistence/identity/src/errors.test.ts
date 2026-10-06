import { describe, expect, it } from 'vitest';
import { AuthError } from '../../../domain/identity/src/index.js';
import {
  IdentityStoreError,
  LastAdministratorError,
  driverErrno,
  isCheckViolation,
  isDuplicateKey,
  isLockContention,
  isMissingParent,
  isReferenced,
  sanitizeStoreError,
} from './errors.js';

describe('driver error classification', () => {
  it('reads errno and code from the driver error or from the error itself', () => {
    expect(driverErrno({ driverError: { errno: 1062 } })).toBe(1062);
    expect(driverErrno({ errno: 1213 })).toBe(1213);
    expect(driverErrno({ errno: '1213' })).toBeNull();
    expect(driverErrno(null)).toBeNull();
    expect(driverErrno('boom')).toBeNull();
    expect(isDuplicateKey({ code: 'ER_DUP_ENTRY' })).toBe(true);
    expect(isDuplicateKey({ driverError: { errno: 1062 } })).toBe(true);
    expect(isDuplicateKey({ driverError: { code: 'ER_DUP_ENTRY' } })).toBe(true);
    expect(isDuplicateKey({ errno: 1063 })).toBe(false);
    expect(isDuplicateKey(undefined)).toBe(false);
    expect(isDuplicateKey({ code: 5 })).toBe(false);
    expect(isMissingParent({ errno: 1452 })).toBe(true);
    expect(isReferenced({ code: 'ER_ROW_IS_REFERENCED_2' })).toBe(true);
    expect(isCheckViolation({ errno: 3819 })).toBe(true);
    expect(isLockContention({ errno: 1213 })).toBe(true);
    expect(isLockContention({ driverError: { code: 'ER_LOCK_WAIT_TIMEOUT' } })).toBe(true);
    expect(isLockContention({ errno: 1 })).toBe(false);
  });
});

describe('sanitizeStoreError', () => {
  it('passes domain errors through untouched', () => {
    const auth = new AuthError('forbidden');
    const last = new LastAdministratorError();
    const store = new IdentityStoreError('unavailable');
    expect(sanitizeStoreError(auth)).toBe(auth);
    expect(sanitizeStoreError(last)).toBe(last);
    expect(sanitizeStoreError(store)).toBe(store);
  });

  it('maps driver errors to coarse, parameter-free errors', () => {
    const leaky = (errno: number, code: string) =>
      Object.assign(new Error("Duplicate entry 'idp|jane.doe@example.test' for key"), {
        errno,
        code,
        parameters: ['jane.doe@example.test'],
        query: 'INSERT ...',
      });
    expect(sanitizeStoreError(leaky(1062, 'ER_DUP_ENTRY'))).toMatchObject({ code: 'conflict' });
    for (const [errno, code, expected] of [
      [1452, 'ER_NO_REFERENCED_ROW_2', 'integrity'],
      [1451, 'ER_ROW_IS_REFERENCED_2', 'integrity'],
      [3819, 'ER_CHECK_CONSTRAINT_VIOLATED', 'integrity'],
      [1213, 'ER_LOCK_DEADLOCK', 'contention'],
      [1205, 'ER_LOCK_WAIT_TIMEOUT', 'contention'],
      [2013, 'PROTOCOL_CONNECTION_LOST', 'unavailable'],
    ] as const) {
      const safe = sanitizeStoreError(leaky(errno, code));
      expect(safe).toBeInstanceOf(IdentityStoreError);
      expect(safe).toMatchObject({ code: expected, errno });
      expect(safe.message).toBe(`Identity store operation failed: ${expected}`);
      expect(JSON.stringify(safe)).not.toContain('jane.doe');
    }
    expect(sanitizeStoreError('weird')).toMatchObject({ code: 'unavailable', errno: null });
    expect(sanitizeStoreError(new Error('plain'))).toMatchObject({ code: 'unavailable' });
  });

  it('marks the last-administrator conflict', () => {
    const error = new LastAdministratorError();
    expect(error).toMatchObject({
      code: 'conflict',
      reason: 'last_admin',
      name: 'LastAdministratorError',
    });
  });
});
