import {
  AuthError,
  IdentityService,
  type IdentityAccessResolver,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';
export interface AuthResponse<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: { readonly code: string; readonly message: string };
}
const errorResponse = (error: unknown): AuthResponse<never> =>
  error instanceof AuthError
    ? { ok: false, error: { code: error.code, message: error.message } }
    : { ok: false, error: { code: 'internal_error', message: 'Request failed' } };
export class AuthApi {
  public constructor(
    private readonly service: IdentityService,
    private readonly accessResolver: IdentityAccessResolver,
  ) {}
  public async login(
    provider: string,
    subject: string,
  ): Promise<AuthResponse<{ token: string; expiresAt: Date }>> {
    try {
      const identity = await this.service.linkExternal(provider, subject);
      const tenantId = await this.accessResolver.resolveActiveTenant(identity.id);
      if (!tenantId) throw new AuthError('unauthorized');
      return { ok: true, value: await this.service.createSession(identity.id, tenantId) };
    } catch (error) {
      return errorResponse(error);
    }
  }
  public async session(token: string, correlationId: string): Promise<AuthResponse<TenantContext>> {
    try {
      return { ok: true, value: await this.service.authenticate(token, correlationId) };
    } catch (error) {
      return errorResponse(error);
    }
  }
  public async logout(token: string): Promise<AuthResponse<null>> {
    try {
      await this.service.revoke(token);
      return { ok: true, value: null };
    } catch (error) {
      return errorResponse(error);
    }
  }
  public async authorize(
    context: TenantContext,
    permission: Permission,
  ): Promise<AuthResponse<null>> {
    try {
      const granted = await this.accessResolver.resolvePermissions(context);
      await this.service.requirePermission(context, permission, granted);
      return { ok: true, value: null };
    } catch (error) {
      return errorResponse(error);
    }
  }
}
