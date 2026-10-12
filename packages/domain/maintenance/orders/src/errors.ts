export type WorkOrderErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'forbidden'
  | 'stale_version'
  | 'invalid_transition'
  | 'missing_requirements'
  | 'invalid_association'
  | 'duplicate';

export class WorkOrderError extends Error {
  public constructor(
    public readonly code: WorkOrderErrorCode,
    /** Stable requirement ids for `missing_requirements` (SPECS §6: structured missing list). */
    public readonly missingRequirements: readonly string[] = [],
  ) {
    super(`Work order request rejected: ${code}`);
    this.name = 'WorkOrderError';
  }
}
