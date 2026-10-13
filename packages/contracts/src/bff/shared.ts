export const CSRF_HEADER = 'x-csrf-token';

/** Request header of idempotent commands (SPECS:195): 8-128 characters of [A-Za-z0-9_-]. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const isIdempotencyKey = (value: unknown): value is string =>
  typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value);

export type BffMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** How a route is protected. `session-csrf` also requires the session-bound token on state changes. */
export type BffRouteKind = 'public' | 'pre-session' | 'session' | 'session-csrf';

/** Uniform error bodies: fixed texts, never anything from the request, a stack or a store. */
export const BFF_ERRORS = {
  bad_request: { status: 400, message: 'Invalid request' },
  idempotency_key_required: { status: 400, message: 'Invalid request' },
  unauthorized: { status: 401, message: 'Authentication required' },
  forbidden: { status: 403, message: 'Permission denied' },
  csrf_failed: { status: 403, message: 'Request rejected' },
  not_found: { status: 404, message: 'Resource not found' },
  method_not_allowed: { status: 405, message: 'Method not allowed' },
  conflict: { status: 409, message: 'Conflict' },
  last_admin: { status: 409, message: 'Conflict' },
  duplicate: { status: 409, message: 'Conflict' },
  stale_version: { status: 409, message: 'Conflict' },
  idempotency_conflict: { status: 409, message: 'Conflict' },
  invalid_transition: { status: 409, message: 'Conflict' },
  immutable: { status: 409, message: 'Conflict' },
  area_in_use: { status: 409, message: 'Conflict' },
  principal_taken: { status: 409, message: 'Conflict' },
  already_assigned: { status: 409, message: 'Conflict' },
  odometer_decrease: { status: 422, message: 'Unprocessable request' },
  invalid_area: { status: 422, message: 'Unprocessable request' },
  invalid_owner: { status: 422, message: 'Unprocessable request' },
  invalid_vehicle: { status: 422, message: 'Unprocessable request' },
  invalid_employee: { status: 422, message: 'Unprocessable request' },
  invalid_hierarchy: { status: 422, message: 'Unprocessable request' },
  invalid_responsible: { status: 422, message: 'Unprocessable request' },
  rule_violation: { status: 422, message: 'Unprocessable request' },
  missing_requirements: { status: 422, message: 'Unprocessable request' },
  payload_too_large: { status: 413, message: 'Payload too large' },
  unsupported_media_type: { status: 415, message: 'Unsupported media type' },
  internal_error: { status: 500, message: 'Request failed' },
} as const;

export type BffErrorCode = keyof typeof BFF_ERRORS;

export interface BffErrorBody {
  readonly code: BffErrorCode;
  readonly status: number;
  readonly message: string;
  readonly correlationId: string;
  /**
   * Only on `duplicate` (the unique field that collided: `economic_number`, `plate`, `vin`,
   * `employee_number`, `national_id` or `email`), `area_in_use` (the kind of resource that blocks:
   * `sub_areas`, `vehicles` or `people`), `invalid_area` (`area_id`), `invalid_owner`
   * (`owner_id`), `invalid_vehicle` (`vehicle_id`), `invalid_employee` (`employee_id`),
   * `principal_taken` (`vehicle_id` when the vehicle already has a current principal,
   * `employee_id` when the driver is already principal of another vehicle), `already_assigned`
   * (`employee_id`) and `rule_violation` (the id of the broken business rule, for example
   * `occurred_at_in_future`); never a value or a count.
   */
  readonly field?: string;
  /** Only on `missing_requirements`: stable ids of the workflow requirements still missing. */
  readonly missingRequirements?: readonly string[];
  /**
   * Only on `bad_request` of the incident routes: the rejected fields by name and reason, never the
   * values that were sent. `rule_violation` carries the id of the broken business rule in `field`.
   */
  readonly fieldErrors?: readonly BffFieldError[];
}
export interface BffFieldError {
  readonly field: string;
  readonly code: 'required' | 'invalid' | 'unknown_property' | 'conflict';
}

export const isBffErrorBody = (value: unknown): value is BffErrorBody => {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Partial<BffErrorBody>;
  return (
    typeof body.code === 'string' &&
    Object.hasOwn(BFF_ERRORS, body.code) &&
    typeof body.status === 'number' &&
    typeof body.message === 'string' &&
    typeof body.correlationId === 'string' &&
    (body.field === undefined || typeof body.field === 'string') &&
    (body.missingRequirements === undefined ||
      (Array.isArray(body.missingRequirements) &&
        body.missingRequirements.every((item) => typeof item === 'string'))) &&
    (body.fieldErrors === undefined ||
      (Array.isArray(body.fieldErrors) &&
        body.fieldErrors.every(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as BffFieldError).field === 'string' &&
            typeof (item as BffFieldError).code === 'string',
        )))
  );
};

export interface BffRouteDefinition {
  readonly method: BffMethod;
  /** Path segments; `:name` is a parameter segment. */
  readonly path: readonly string[];
  readonly kind: BffRouteKind;
  /** Status of the successful response. */
  readonly status: 200 | 201 | 204;
  /** Largest request body, when the route needs more than the handler's default (bulk import). */
  readonly maxBodyBytes?: number;
  /**
   * The route accepts the `Idempotency-Key` header. It is optional except for the body `command`s
   * listed in `requiredFor`, which answer 400 `idempotency_key_required` without it.
   */
  readonly idempotency?: { readonly requiredFor: readonly string[] };
}
