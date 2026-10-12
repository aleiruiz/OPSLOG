export type MaintenancePlanErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'duplicate'
  | 'stale_version'
  | 'invalid_association'
  | 'odometer_decrease';

export class MaintenancePlanError extends Error {
  public constructor(public readonly code: MaintenancePlanErrorCode) {
    super(`Maintenance plan request rejected: ${code}`);
    this.name = 'MaintenancePlanError';
  }
}
