import { describe, expect, it } from 'vitest';
import { AreaError } from '../../../domain/areas/src/index.js';
import {
  AreaStoreError,
  driverErrno,
  isCheckViolation,
  isDuplicateKey,
  isLockContention,
  isMissingParent,
  sanitizeStoreError,
} from './errors.js';

const driver = (errno: number, code: string) => ({ driverError: { errno, code } });

describe('driver error predicates', () => {
  it('reads errno and code from the driver error or the error itself', () => {
    expect(driverErrno(driver(1062, 'ER_DUP_ENTRY'))).toBe(1062);
    expect(driverErrno({ errno: 1213 })).toBe(1213);
    expect(driverErrno({ errno: '1213' })).toBeNull();
    expect(driverErrno(null)).toBeNull();
    expect(driverErrno('boom')).toBeNull();
    expect(isDuplicateKey(driver(1062, 'x'))).toBe(true);
    expect(isDuplicateKey({ code: 'ER_DUP_ENTRY' })).toBe(true);
    expect(isDuplicateKey({ driverError: { code: 7 } })).toBe(false);
    expect(isDuplicateKey(5)).toBe(false);
    expect(isMissingParent(driver(1452, 'x'))).toBe(true);
    expect(isMissingParent(driver(1216, 'x'))).toBe(true);
    expect(isMissingParent({ code: 'ER_NO_REFERENCED_ROW' })).toBe(true);
    expect(isCheckViolation(driver(3819, 'x'))).toBe(true);
    expect(isLockContention(driver(1213, 'x'))).toBe(true);
    expect(isLockContention({ code: 'ER_LOCK_WAIT_TIMEOUT' })).toBe(true);
    expect(isLockContention(driver(1, 'x'))).toBe(false);
  });
});

describe('sanitizeStoreError', () => {
  it('passes domain and store errors through unchanged', () => {
    const domain = new AreaError('duplicate', 'name');
    const store = new AreaStoreError('contention', 1213);
    expect(sanitizeStoreError(domain)).toBe(domain);
    expect(sanitizeStoreError(store)).toBe(store);
  });
  it('maps constraint, contention and other driver failures to coarse codes with the errno only', () => {
    expect(sanitizeStoreError(driver(1452, 'x'))).toMatchObject({ code: 'integrity', errno: 1452 });
    expect(sanitizeStoreError(driver(3819, 'x'))).toMatchObject({ code: 'integrity', errno: 3819 });
    expect(sanitizeStoreError(driver(1205, 'x'))).toMatchObject({
      code: 'contention',
      errno: 1205,
    });
    expect(sanitizeStoreError(driver(2013, 'x'))).toMatchObject({
      code: 'unavailable',
      errno: 2013,
    });
    expect(sanitizeStoreError({ code: 'ECONNRESET' })).toMatchObject({
      code: 'unavailable',
      errno: null,
    });
  });
  it('treats failures without a driver shape as internal and never carries the message', () => {
    const error = sanitizeStoreError(new Error('plate AB-123 C for tenant-a'));
    expect(error).toMatchObject({ code: 'internal', errno: null });
    expect(error.message).toBe('Area store operation failed: internal');
    expect(sanitizeStoreError('text')).toMatchObject({ code: 'internal' });
  });
  it('survives hostile values', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      },
    );
    expect(sanitizeStoreError(hostile)).toMatchObject({ code: 'internal' });
  });
});
