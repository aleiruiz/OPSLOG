export type WebhookErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'stale_version'
  | 'limit_reached'
  | 'invalid_transition';

/** A rejected command. The code and the offending field only: never the URL or a secret. */
export class WebhookError extends Error {
  public constructor(
    public readonly code: WebhookErrorCode,
    public readonly field?: string,
  ) {
    super(`webhook request rejected: ${code}`);
    this.name = 'WebhookError';
  }
}
