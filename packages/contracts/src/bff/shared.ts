export const CSRF_HEADER = 'x-csrf-token';

export type BffMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** How a route is protected. `session-csrf` also requires the session-bound token on state changes. */
export type BffRouteKind = 'public' | 'pre-session' | 'session' | 'session-csrf';

/** Uniform error bodies: fixed texts, never anything from the request, a stack or a store. */
export const BFF_ERRORS = {
  bad_request: { status: 400, message: 'Invalid request' },
  unauthorized: { status: 401, message: 'Authentication required' },
  forbidden: { status: 403, message: 'Permission denied' },
  csrf_failed: { status: 403, message: 'Request rejected' },
  not_found: { status: 404, message: 'Resource not found' },
  method_not_allowed: { status: 405, message: 'Method not allowed' },
  conflict: { status: 409, message: 'Conflict' },
  last_admin: { status: 409, message: 'Conflict' },
  duplicate: { status: 409, message: 'Conflict' },
  stale_version: { status: 409, message: 'Conflict' },
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
   * `employee_id` when the driver is already principal of another vehicle) and `already_assigned`
   * (`employee_id`); never a value or a count.
   */
  readonly field?: string;
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
    (body.field === undefined || typeof body.field === 'string')
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
}
