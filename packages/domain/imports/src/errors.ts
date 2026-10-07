export type ImportErrorCode =
  | 'invalid_input'
  | 'not_found'
  /** The idempotency key was used for a different request, or the dry run no longer matches the rows. */
  | 'conflict';

export class ImportError extends Error {
  public constructor(public readonly code: ImportErrorCode) {
    super(`Import request rejected: ${code}`);
    this.name = 'ImportError';
  }
}

export const invalid = (): never => {
  throw new ImportError('invalid_input');
};
