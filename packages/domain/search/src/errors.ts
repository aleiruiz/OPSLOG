export type SearchErrorCode = 'invalid_input';

/** Fixed-message failure of the search; it never carries what the reader typed. */
export class SearchError extends Error {
  public constructor(public readonly code: SearchErrorCode) {
    super(`Search request rejected: ${code}`);
    this.name = 'SearchError';
  }
}
