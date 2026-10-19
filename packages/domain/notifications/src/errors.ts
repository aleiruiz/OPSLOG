export type NotificationErrorCode =
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  /** A mandatory notice cannot be switched off. */
  | 'mandatory';

export class NotificationError extends Error {
  public constructor(
    public readonly code: NotificationErrorCode,
    public readonly field?: string,
  ) {
    super(code);
    this.name = 'NotificationError';
  }
}
