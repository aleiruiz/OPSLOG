import { AuthError } from '../../../../packages/domain/identity/src/index.js';
import { ExportError } from '../../../../packages/domain/exports/src/index.js';
import { ReportError } from '../../../../packages/domain/reports/src/index.js';

/** Same shape as the composition's responses: a value, or a code with its status and a fixed text. */
export type ReportsApiResponse<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly status: number;
        readonly message: string;
        readonly field?: string;
        /** Id of the broken business rule of a 422. */
        readonly rule?: string;
      };
    };

const STATUS: Readonly<Record<string, number>> = {
  invalid_input: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  gone: 410,
  rule_violation: 422,
  rate_limited: 429,
  internal_error: 500,
};

/** Domain code to the code the BFF understands. */
function codeOf(error: unknown): string {
  if (error instanceof ReportError)
    return error.code === 'too_many_rows' ? 'rule_violation' : error.code;
  if (error instanceof ExportError) {
    if (error.code === 'expired') return 'gone';
    if (error.code === 'too_many_open') return 'rate_limited';
    if (error.code === 'not_ready') return 'conflict';
    return error.code;
  }
  if (error instanceof AuthError)
    return error.code === 'expired' || error.code === 'unauthorized'
      ? 'unauthorized'
      : error.code === 'forbidden'
        ? 'forbidden'
        : error.code === 'invalid_input'
          ? 'invalid_input'
          : 'internal_error';
  return 'internal_error';
}

/**
 * Any failure becomes a code, its status and a fixed text: no value of the request, no store or
 * renderer message. `field` is only the name of the offending field.
 */
export function apiFailure(error: unknown): ReportsApiResponse<never> {
  const code = codeOf(error);
  const field =
    (error instanceof ReportError || error instanceof ExportError) && error.field
      ? { field: error.field }
      : {};
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code] ?? 500,
      message: code === 'internal_error' ? 'Request failed' : `Reports request rejected: ${code}`,
      ...field,
      ...(code === 'rule_violation' && error instanceof ReportError ? { rule: error.code } : {}),
    },
  };
}

/** What both APIs need of the platform: the session with its grants. */
export interface ReportsSession {
  readonly tenantId: string;
  /** Identity subject of the reader. */
  readonly subject: string;
  /** Digest of the session. */
  readonly sessionId: string;
  readonly permissions: readonly string[];
}

export type ReportsAuthorize = (token: string, correlationId: string) => Promise<ReportsSession>;
