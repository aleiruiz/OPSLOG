import { r } from './validation-support.js';

export interface FieldError {
  field: string;
  code: string;
  message: string;
}
export interface ApiError {
  code: string;
  status: ApiErrorStatus;
  message: string;
  fieldErrors?: readonly FieldError[];
  missingRequirements?: readonly string[];
  correlationId: string;
}
export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503;
const ERROR_STATUS: Record<string, ApiErrorStatus> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable_entity: 422,
  rate_limited: 429,
  unavailable: 503,
  internal_error: 500 as ApiErrorStatus,
};
const ERROR_MESSAGES: Record<string, string> = {
  bad_request: 'Invalid request',
  unauthorized: 'Authentication required',
  forbidden: 'Permission denied',
  not_found: 'Resource not found',
  conflict: 'Conflict',
  unprocessable_entity: 'Business rule violation',
  rate_limited: 'Too many requests',
  unavailable: 'Service temporarily unavailable',
  internal_error: 'Request failed',
};
const FIELD_MESSAGES: Record<string, string> = {
  required: 'Field is required',
  invalid_type: 'Invalid value',
  invalid_enum: 'Invalid option',
  invalid_uuid: 'Invalid identifier',
  invalid_datetime: 'Invalid date and time',
  invalid_range: 'Invalid range',
  unknown_property: 'Property is not allowed',
};
const ERROR_CODES = Object.keys(ERROR_MESSAGES);
const safe = (v: unknown, max = 160): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';
export function serializeApiError(input: unknown): ApiError {
  const v = r(input) ? input : {};
  const code = ERROR_CODES.includes(safe(v.code)) ? safe(v.code) : 'internal_error';
  const result: ApiError = {
    code,
    status: ERROR_STATUS[code]!,
    message: ERROR_MESSAGES[code]!,
    correlationId: safe(v.correlationId, 100) || 'unknown',
  };
  if (Array.isArray(v.fieldErrors)) {
    const fields = v.fieldErrors.flatMap((item) => {
      if (!r(item)) return [];
      const field = safe(item.field, 80);
      const fieldCode = safe(item.code);
      return field && FIELD_MESSAGES[fieldCode]
        ? [{ field, code: fieldCode, message: FIELD_MESSAGES[fieldCode]! }]
        : [];
    });
    if (fields.length) result.fieldErrors = fields;
  }
  if (Array.isArray(v.missingRequirements)) {
    const missing = v.missingRequirements.flatMap((item) => {
      const value = safe(item, 120);
      return value ? [value] : [];
    });
    if (missing.length) result.missingRequirements = missing;
  }
  return result;
}
export function notFoundApiError(correlationId: string): ApiError {
  return serializeApiError({ code: 'not_found', correlationId });
}
