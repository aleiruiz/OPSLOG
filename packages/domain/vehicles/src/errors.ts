export type VehicleErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'duplicate'
  | 'stale_version'
  | 'invalid_transition'
  | 'odometer_decrease'
  | 'immutable'
  /** The target area is unknown, of another tenant or inactive (all indistinguishable). */
  | 'invalid_area';

/** Which unique key collided (`duplicate`) or which input is invalid (`invalid_area`). Never a value. */
export type VehicleConflictField = 'economic_number' | 'plate' | 'vin' | 'area_id';

export class VehicleError extends Error {
  public constructor(
    public readonly code: VehicleErrorCode,
    public readonly field?: VehicleConflictField,
  ) {
    super(`Vehicle request rejected: ${code}`);
    this.name = 'VehicleError';
  }
}
