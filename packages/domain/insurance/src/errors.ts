export type PolicyErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'stale_version'
  | 'immutable'
  /** The vehicle is unknown, of another tenant or archived (all indistinguishable). */
  | 'invalid_vehicle';

/** Which input is invalid (`invalid_vehicle`). Never a value. */
export type PolicyConflictField = 'vehicle_id';

export class PolicyError extends Error {
  public constructor(
    public readonly code: PolicyErrorCode,
    public readonly field?: PolicyConflictField,
  ) {
    super(`Policy request rejected: ${code}`);
    this.name = 'PolicyError';
  }
}
