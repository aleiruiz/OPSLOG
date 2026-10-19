import { AuthError } from '../../../../packages/domain/identity/src/index.js';
import { NotificationError } from '../../../../packages/domain/notifications/src/index.js';

/** Same shape as the composition's responses: a value, or a code with its status and a fixed text. */
export type NotificationsApiResponse<T> =
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
  rule_violation: 422,
  internal_error: 500,
};

/** Domain code to the code the BFF understands; a mandatory notice that cannot be switched off is a 422. */
function codeOf(error: unknown): string {
  if (error instanceof NotificationError)
    return error.code === 'mandatory' ? 'rule_violation' : error.code;
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

/** Any failure becomes a code, its status and a fixed text: no value of the request, no store message. */
export function apiFailure(error: unknown): NotificationsApiResponse<never> {
  const code = codeOf(error);
  const field = error instanceof NotificationError && error.field ? { field: error.field } : {};
  return {
    ok: false,
    error: {
      code,
      status: STATUS[code] ?? 500,
      message:
        code === 'internal_error' ? 'Request failed' : `Notifications request rejected: ${code}`,
      ...field,
      ...(code === 'rule_violation' && error instanceof NotificationError
        ? { rule: error.code }
        : {}),
    },
  };
}
