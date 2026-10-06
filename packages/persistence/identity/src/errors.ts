import { AuthError } from '../../../domain/identity/src/index.js';

/** Removing or demoting this administrator would leave the tenant without an active administrator (SPECS §5.3). */
export class LastAdministratorError extends AuthError {
  public readonly reason = 'last_admin' as const;
  public constructor() {
    super('conflict');
    this.name = 'LastAdministratorError';
  }
}

/** `internal`: a non-driver failure (programming error, TypeORM misuse); `origin`/`frames` identify it. */
export type IdentityStoreErrorCode = 'unavailable' | 'contention' | 'integrity' | 'internal';

/**
 * Sanitized infrastructure failure. The driver error is deliberately dropped: MySQL messages and
 * TypeORM `QueryFailedError.parameters` can contain subjects, token hashes or tenant ids (PII/secrets).
 * Only a fixed message, a coarse code and the numeric driver errno survive; for non-driver (programming)
 * errors also the class name and the stack frames, so they stay diagnosable without exposing data.
 */
export class IdentityStoreError extends Error {
  public constructor(
    public readonly code: IdentityStoreErrorCode,
    public readonly errno: number | null = null,
    /** Class name of a non-driver cause (never its message). */
    public readonly origin: string | null = null,
    /** Stack frames of a non-driver cause, without the message line: locations only, no data. */
    public readonly frames: readonly string[] = [],
  ) {
    super(`Identity store operation failed: ${code}`);
    this.name = 'IdentityStoreError';
  }
}

interface DriverErrorShape {
  readonly code?: unknown;
  readonly errno?: unknown;
  readonly driverError?: { readonly code?: unknown; readonly errno?: unknown };
}

export function driverErrno(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as DriverErrorShape;
  const errno = candidate.driverError?.errno ?? candidate.errno;
  return typeof errno === 'number' ? errno : null;
}

function driverCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as DriverErrorShape;
  const code = candidate.driverError?.code ?? candidate.code;
  return typeof code === 'string' ? code : null;
}

const matches = (error: unknown, errno: number, code: string): boolean =>
  driverErrno(error) === errno || driverCode(error) === code;

export const isDuplicateKey = (error: unknown): boolean => matches(error, 1062, 'ER_DUP_ENTRY');
/** Missing parent row: 1452 (_2), or 1216 which MySQL reports to accounts without DDL privileges. */
export const isMissingParent = (error: unknown): boolean =>
  matches(error, 1452, 'ER_NO_REFERENCED_ROW_2') || matches(error, 1216, 'ER_NO_REFERENCED_ROW');
/** Would orphan child rows: 1451 (_2) or 1217. */
export const isReferenced = (error: unknown): boolean =>
  matches(error, 1451, 'ER_ROW_IS_REFERENCED_2') || matches(error, 1217, 'ER_ROW_IS_REFERENCED');
export const isCheckViolation = (error: unknown): boolean =>
  matches(error, 3819, 'ER_CHECK_CONSTRAINT_VIOLATED');
export const isLockContention = (error: unknown): boolean =>
  matches(error, 1213, 'ER_LOCK_DEADLOCK') || matches(error, 1205, 'ER_LOCK_WAIT_TIMEOUT');

/** Maps any thrown value to an error that is safe to log and to return upstream. */
export function sanitizeStoreError(error: unknown): Error {
  if (error instanceof AuthError || error instanceof IdentityStoreError) return error;
  if (isDuplicateKey(error)) return new AuthError('conflict');
  if (isMissingParent(error) || isReferenced(error) || isCheckViolation(error))
    return new IdentityStoreError('integrity', driverErrno(error));
  if (isLockContention(error)) return new IdentityStoreError('contention', driverErrno(error));
  if (driverErrno(error) === null && driverCode(error) === null) {
    const stack = error instanceof Error ? (error.stack ?? '') : '';
    const frames = stack
      .split('\n')
      .filter((line) => line.trimStart().startsWith('at '))
      .slice(0, 8)
      .map((line) => line.trim());
    return new IdentityStoreError(
      'internal',
      null,
      error instanceof Error ? error.name : typeof error,
      frames,
    );
  }
  return new IdentityStoreError('unavailable', driverErrno(error));
}
