import { DocumentError } from '../../../domain/documents/src/index.js';

export type DocumentStoreErrorCode = 'unavailable' | 'contention' | 'integrity' | 'internal';

/**
 * Sanitized infrastructure failure. The driver error is deliberately dropped: MySQL messages and
 * TypeORM `QueryFailedError.parameters` carry document numbers, titles, notes and tenant ids. Only a fixed message, a
 * coarse code and the numeric driver errno survive.
 */
export class DocumentStoreError extends Error {
  public constructor(
    public readonly code: DocumentStoreErrorCode,
    public readonly errno: number | null = null,
  ) {
    super(`Document store operation failed: ${code}`);
    this.name = 'DocumentStoreError';
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
export const isCheckViolation = (error: unknown): boolean =>
  matches(error, 3819, 'ER_CHECK_CONSTRAINT_VIOLATED');
export const isLockContention = (error: unknown): boolean =>
  matches(error, 1213, 'ER_LOCK_DEADLOCK') || matches(error, 1205, 'ER_LOCK_WAIT_TIMEOUT');

/** Maps any thrown value to an error that is safe to log and to return upstream. Never throws. */
export function sanitizeStoreError(error: unknown): Error {
  try {
    if (error instanceof DocumentError || error instanceof DocumentStoreError) return error;
    if (isMissingParent(error) || isCheckViolation(error))
      return new DocumentStoreError('integrity', driverErrno(error));
    if (isLockContention(error)) return new DocumentStoreError('contention', driverErrno(error));
    if (driverErrno(error) === null && driverCode(error) === null)
      return new DocumentStoreError('internal');
    return new DocumentStoreError('unavailable', driverErrno(error));
  } catch {
    // Hostile values (Proxy traps, throwing accessors) get a generic, data-free error.
    return new DocumentStoreError('internal');
  }
}
