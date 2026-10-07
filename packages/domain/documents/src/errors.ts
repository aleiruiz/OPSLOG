export type DocumentErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'stale_version'
  | 'immutable'
  /** The owner is unknown, of another tenant or archived (all indistinguishable). */
  | 'invalid_owner';

/** Which input is invalid (`invalid_owner`). Never a value. */
export type DocumentConflictField = 'owner_id';

export class DocumentError extends Error {
  public constructor(
    public readonly code: DocumentErrorCode,
    public readonly field?: DocumentConflictField,
  ) {
    super(`Document request rejected: ${code}`);
    this.name = 'DocumentError';
  }
}
