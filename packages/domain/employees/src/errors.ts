export type EmployeeErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'duplicate'
  | 'stale_version'
  | 'invalid_transition'
  | 'immutable'
  /** The target area is unknown, of another tenant or inactive (all indistinguishable). */
  | 'invalid_area';

/** Which unique key collided (`duplicate`) or which input is invalid (`invalid_area`). Never a value. */
export type EmployeeConflictField = 'employee_number' | 'national_id' | 'email' | 'area_id';

export class EmployeeError extends Error {
  public constructor(
    public readonly code: EmployeeErrorCode,
    public readonly field?: EmployeeConflictField,
  ) {
    super(`Employee request rejected: ${code}`);
    this.name = 'EmployeeError';
  }
}
