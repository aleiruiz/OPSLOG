export type ReportErrorCode = 'not_found' | 'forbidden' | 'invalid_input' | 'too_many_rows';

/** A report failure: a code and the name of the field, never a value of the request. */
export class ReportError extends Error {
  public constructor(
    public readonly code: ReportErrorCode,
    public readonly field?: string,
  ) {
    super(code);
    this.name = 'ReportError';
  }
}
