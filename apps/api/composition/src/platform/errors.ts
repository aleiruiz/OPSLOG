import { AuthError } from '../../../../../packages/domain/identity/src/index.js';

export type PlatformErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'last_admin';

export class PlatformError extends Error {
  public constructor(public readonly code: PlatformErrorCode) {
    super(`Platform request rejected: ${code}`);
    this.name = 'PlatformError';
  }
}

export interface PlatformResponse<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: {
    readonly code: string;
    readonly status: number;
    readonly message: string;
    /** Only for a duplicate or an invalid area: the field (never its value). */
    readonly field?: string;
  };
}

const STATUS: Readonly<Record<PlatformErrorCode | 'internal_error', number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  last_admin: 409,
  internal_error: 500,
};

export function failure(error: unknown): PlatformResponse<never> {
  let code: PlatformErrorCode | 'internal_error' = 'internal_error';
  if (error instanceof PlatformError) code = error.code;
  else if (error instanceof AuthError)
    code =
      (error as { reason?: unknown }).reason === 'last_admin'
        ? 'last_admin'
        : error.code === 'expired'
          ? 'unauthorized'
          : error.code;
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code],
      message: code === 'internal_error' ? 'Request failed' : `Platform request rejected: ${code}`,
    },
  };
}

export const success = <T>(value: T): PlatformResponse<T> => ({ ok: true, value });

export const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
