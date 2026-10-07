export type AreaErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'duplicate'
  | 'stale_version'
  /** Activating an active area or deactivating an inactive one. */
  | 'invalid_transition'
  /** An inactive area is read-only until it is activated again. */
  | 'immutable'
  /** Cycle, more than four levels, or a parent that is unknown (or of another tenant) or inactive. */
  | 'invalid_hierarchy'
  /** A responsible user that is not an active member of the tenant. */
  | 'invalid_responsible'
  /** BR-021: the area still holds active sub-areas, vehicles or people. */
  | 'area_in_use';

/** Which key collided (`duplicate`) or which kind of resource blocks (`area_in_use`). Never a value. */
export type AreaConflictField = 'name' | 'code' | 'sub_areas' | 'vehicles' | 'people';

export class AreaError extends Error {
  public constructor(
    public readonly code: AreaErrorCode,
    public readonly field?: AreaConflictField,
  ) {
    super(`Area request rejected: ${code}`);
    this.name = 'AreaError';
  }
}
