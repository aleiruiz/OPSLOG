export type SavedViewErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  | 'stale_version'
  | 'duplicate'
  | 'limit_reached';

/** Fixed-message failure of the saved views; it never carries a name, a filter or a value. */
export class SavedViewError extends Error {
  public constructor(public readonly code: SavedViewErrorCode) {
    super(`Saved view request rejected: ${code}`);
    this.name = 'SavedViewError';
  }
}
