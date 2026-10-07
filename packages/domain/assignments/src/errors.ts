export type AssignmentErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'stale_version'
  /** The assignment already ended: it is read-only. */
  | 'immutable'
  /** The vehicle is unknown, of another tenant, archived or not assignable (indistinguishable). */
  | 'invalid_vehicle'
  /** The employee is unknown, of another tenant, archived, not a driver or not active (indistinguishable). */
  | 'invalid_employee'
  /** BR-002 / BR-003: a principal already exists for the vehicle or for the driver. */
  | 'principal_taken'
  /** The driver already holds a current assignment on this vehicle. */
  | 'already_assigned';

/** Which input is at fault. Never a value. */
export type AssignmentConflictField = 'vehicle_id' | 'employee_id';

export class AssignmentError extends Error {
  public constructor(
    public readonly code: AssignmentErrorCode,
    public readonly field?: AssignmentConflictField,
  ) {
    super(`Assignment request rejected: ${code}`);
    this.name = 'AssignmentError';
  }
}
