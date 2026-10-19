export type ExportErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'not_ready'
  | 'expired'
  | 'too_many_open'
  | 'idempotency_conflict'
  | 'invalid_input';

export class ExportError extends Error {
  public constructor(
    public readonly code: ExportErrorCode,
    public readonly field?: string,
  ) {
    super(code);
    this.name = 'ExportError';
  }
}
