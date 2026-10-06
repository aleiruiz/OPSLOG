import {
  BFF_ERRORS,
  type BffErrorBody,
  type BffErrorCode,
} from '../../../../packages/contracts/src/index.js';

export type HeaderValue = string | readonly string[] | undefined;

/**
 * Transport-neutral request. `url` is the origin-form target (path and query). `body` is optional and
 * consumed at most once, so the handler can run without sockets in tests and behind Node's `http`.
 */
export interface BffRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, HeaderValue>>;
  readonly body?: AsyncIterable<Uint8Array> | null | undefined;
}

export interface BffResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly body: string;
}

export type BffHandler = (request: BffRequest) => Promise<BffResponse>;

export type ErrorCode = BffErrorCode;
export type ErrorBody = BffErrorBody;

/** Fixed, generic texts shared with the web client through the contract module. */
export const ERRORS: Readonly<Record<ErrorCode, { status: number; message: string }>> = BFF_ERRORS;

/** Applied to every response, including errors. There is no CORS: the API is same-origin only. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  pragma: 'no-cache',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  vary: 'Cookie, Origin',
};

export function respond(
  status: number,
  body: unknown,
  correlationId: string,
  extra: Readonly<Record<string, string | readonly string[]>> = {},
): BffResponse {
  const empty = body === undefined;
  return {
    status,
    headers: {
      ...SECURITY_HEADERS,
      ...(empty ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      'x-correlation-id': correlationId,
      ...extra,
    },
    body: empty ? '' : JSON.stringify(body),
  };
}

export function errorResponse(
  code: ErrorCode,
  correlationId: string,
  extra: Readonly<Record<string, string | readonly string[]>> = {},
): BffResponse {
  const { status, message } = ERRORS[code];
  const body: ErrorBody = { code, status, message, correlationId };
  return respond(status, body, correlationId, extra);
}

/** First value of a single-valued header; a repeated header is ambiguous and reads as absent. */
export function singleHeader(
  headers: Readonly<Record<string, HeaderValue>>,
  name: string,
): string | undefined {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 1) return value[0] as string;
  return undefined;
}

/** Lower-cases header names so that lookups do not depend on the transport. */
export function normalizeHeaders(
  headers: Readonly<Record<string, HeaderValue>>,
): Record<string, HeaderValue> {
  // No prototype: a header named `__proto__` is an ordinary key, never a prototype assignment.
  const result: Record<string, HeaderValue> = Object.create(null) as Record<string, HeaderValue>;
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    const previous = result[key];
    result[key] =
      previous === undefined
        ? value
        : [
            ...(Array.isArray(previous) ? previous : [previous as string]),
            ...(Array.isArray(value) ? value : value === undefined ? [] : [value as string]),
          ];
  }
  return result;
}
