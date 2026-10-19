export type AuditQueryErrorCode = 'invalid_input' | 'forbidden' | 'not_found';

export class AuditQueryError extends Error {
  public constructor(public readonly code: AuditQueryErrorCode) {
    super(`Audit query rejected: ${code}`);
    this.name = 'AuditQueryError';
  }
}
