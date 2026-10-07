export class AuthError extends Error {
  public constructor(
    public readonly code:
      | 'invalid_input'
      | 'unauthorized'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'expired',
  ) {
    super(code === 'unauthorized' ? 'Authentication required' : 'Authentication request rejected');
    this.name = 'AuthError';
  }
}
