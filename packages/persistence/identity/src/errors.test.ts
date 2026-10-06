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
    expect(isMissingParent({ errno: 1216 })).toBe(true);
    expect(isMissingParent({ code: 'ER_NO_REFERENCED_ROW' })).toBe(true);
    expect(isReferenced({ errno: 1217 })).toBe(true);
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
      [1216, 'ER_NO_REFERENCED_ROW', 'integrity'],
      [1217, 'ER_ROW_IS_REFERENCED', 'integrity'],
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
    expect(sanitizeStoreError('weird')).toMatchObject({
      code: 'internal',
      errno: null,
      origin: 'string',
      frames: [],
    });
    expect(sanitizeStoreError(new Error('plain'))).toMatchObject({
      code: 'internal',
      origin: 'Error',
    });
    // A driver-style error with only a string code (no errno) is still an infrastructure failure.
    expect(sanitizeStoreError({ code: 'PROTOCOL_CONNECTION_LOST' })).toMatchObject({
      code: 'unavailable',
      errno: null,
      origin: null,
    });
    expect(sanitizeStoreError(Object.assign(new Error('x'), { stack: undefined }))).toMatchObject({
      code: 'internal',
      frames: [],
    });
  });

  describe('non-driver errors never leak message or name text', () => {
    const SECRET = 'SECRET-TOKEN-abc';
    const serialized = (error: IdentityStoreError) => JSON.stringify(error);

    it('drops a multi-line message that imitates stack frames', () => {
      const crafted = new Error(`boom\n    at ${SECRET} tenant=t-42\n    at forged (/x/y.ts:1:2)`);
      const safe = sanitizeStoreError(crafted) as IdentityStoreError;
      expect(safe.code).toBe('internal');
      expect(serialized(safe)).not.toContain(SECRET);
      expect(serialized(safe)).not.toContain('t-42');
      expect(serialized(safe)).not.toContain('forged');
      for (const frame of safe.frames) expect(frame).toMatch(/:\d+:\d+\)?$/);
      expect(safe.frames.length).toBeGreaterThan(0);
    });

    it('keeps real frames, which end in line and column', () => {
      const safe = sanitizeStoreError(new Error('plain')) as IdentityStoreError;
      expect(safe.frames.length).toBeGreaterThan(0);
      expect(safe.frames.length).toBeLessThanOrEqual(8);
      expect(safe.frames.every((frame) => frame.startsWith('at '))).toBe(true);
    });

    it('does not trust a message that is absent from the stack header', () => {
      const error = new Error(`changed\n    at ${SECRET} tenant=t-42:9:9`);
      error.stack = `Error: original\n    at ${SECRET} tenant=t-42:9:9`;
      expect((sanitizeStoreError(error) as IdentityStoreError).frames).toEqual([]);
    });

    it('handles an empty message and a forged name', () => {
      const empty = new Error('');
      const safe = sanitizeStoreError(empty) as IdentityStoreError;
      expect(safe.frames.length).toBeGreaterThan(0);
      const renamed = new Error('');
      renamed.name = `jane.doe@example.test\n    at ${SECRET} x:1:2`;
      const renamedSafe = sanitizeStoreError(renamed) as IdentityStoreError;
      expect(JSON.stringify(renamedSafe)).not.toContain(SECRET);
      expect(JSON.stringify(renamedSafe)).not.toContain('jane.doe');
      // A stack captured under the old name no longer matches the header: nothing is kept.
      const stale = new Error('');
      const staleStack = stale.stack as string;
      stale.name = 'Renamed';
      stale.stack = staleStack;
      expect((sanitizeStoreError(stale) as IdentityStoreError).frames).toEqual([]);
      const noNewline = Object.assign(new Error(''), { stack: 'Error' });
      expect((sanitizeStoreError(noNewline) as IdentityStoreError).frames).toEqual([]);
    });

    it('keeps nothing when the message was truncated or emptied after the stack was read', () => {
      const truncated = new Error(`original\n    at ${SECRET} tenant=t-42`);
      const captured = truncated.stack as string;
      truncated.message = 'r';
      truncated.stack = captured;
      const a = sanitizeStoreError(truncated) as IdentityStoreError;
      expect(a.frames).toEqual([]);
      const emptied = new Error(`original\n    at ${SECRET} tenant=t-42`);
      const stack = emptied.stack as string;
      emptied.message = '';
      emptied.stack = stack;
      const b = sanitizeStoreError(emptied) as IdentityStoreError;
      expect(b.frames).toEqual([]);
      expect(serialized(a) + serialized(b)).not.toContain(SECRET);
    });

    it('refuses frame-shaped lines that carry personal data', () => {
      const error = new Error('x');
      error.stack = [
        'Error: x',
        '    at carol@example.com (q.js:1:1)',
        '    at fn (/srv/app/file name.js:3:4)',
        '    at ok (/srv/app/file.js:3:4)',
        '    at /srv/app/other.js:5:6',
      ].join('\n');
      const safe = sanitizeStoreError(error) as IdentityStoreError;
      expect(safe.frames).toEqual(['at ok (/srv/app/file.js:3:4)', 'at /srv/app/other.js:5:6']);
    });

    it('falls back to no frames when reading the error throws', () => {
      const hostile = new Error('x');
      Object.defineProperty(hostile, 'stack', {
        get() {
          throw new Error(`boom ${SECRET}`);
        },
      });
      const safe = sanitizeStoreError(hostile) as IdentityStoreError;
      expect(safe).toMatchObject({ code: 'internal', frames: [], origin: 'Error' });
      const noMessage = new Error('x');
      Object.defineProperty(noMessage, 'message', {
        get() {
          throw new Error('nope');
        },
      });
      expect((sanitizeStoreError(noMessage) as IdentityStoreError).frames).toEqual([]);
      const badConstructor = new Error('x');
      Object.defineProperty(badConstructor, 'constructor', {
        get() {
          throw new Error('nope');
        },
      });
      expect((sanitizeStoreError(badConstructor) as IdentityStoreError).origin).toBe('Error');
      const nonString = new Error('x');
      Object.defineProperty(nonString, 'name', { value: 5 });
      expect((sanitizeStoreError(nonString) as IdentityStoreError).frames).toEqual([]);
    });

    it('takes origin from the constructor, restricted to a safe alphabet', () => {
      const emailNamed = new Error('x');
      emailNamed.name = 'jane.doe@example.test';
      const a = sanitizeStoreError(emailNamed) as IdentityStoreError;
      expect(a.origin).toBe('Error');
      expect(serialized(a)).not.toContain('jane.doe');

      class CustomFailure extends Error {}
      expect((sanitizeStoreError(new CustomFailure('m')) as IdentityStoreError).origin).toBe(
        'CustomFailure',
      );

      const odd = new Error('m');
      Object.defineProperty(odd, 'constructor', { value: { name: 'jane@example.test' } });
      expect((sanitizeStoreError(odd) as IdentityStoreError).origin).toBe('Error');
      const long = new Error('m');
      Object.defineProperty(long, 'constructor', { value: { name: 'A'.repeat(65) } });
      expect((sanitizeStoreError(long) as IdentityStoreError).origin).toBe('Error');
      const none = new Error('m');
      Object.defineProperty(none, 'constructor', { value: undefined });
      expect((sanitizeStoreError(none) as IdentityStoreError).origin).toBe('Error');
    });
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
