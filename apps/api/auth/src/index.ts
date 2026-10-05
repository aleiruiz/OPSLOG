import {
  AuthError,
  IdentityService,
  type IdentityAccessResolver,
  type InvitationActivation,
  type Permission,
  type TenantContext,
} from '../../../../packages/domain/identity/src/index.js';
import { isVerifiedExternalPrincipal } from '../../../../packages/platform/auth/src/index.js';
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
    principal: unknown,
  ): Promise<AuthResponse<{ token: string; expiresAt: Date }>> {
    try {
      if (!isVerifiedExternalPrincipal(principal)) throw new AuthError('unauthorized');
      const identity = await this.service.resolveExternal(principal.provider, principal.subject);
      const tenantId = await this.accessResolver.resolveActiveTenant(identity.id);
      if (!tenantId) throw new AuthError('unauthorized');
      return { ok: true, value: await this.service.createSession(identity.id, tenantId) };
    } catch (error) {
      return errorResponse(error);
    }
  }
  public async activateInvitation(
    token: string,
    principal: unknown,
  ): Promise<AuthResponse<InvitationActivation>> {
    try {
      if (!isVerifiedExternalPrincipal(principal)) throw new AuthError('unauthorized');
      return {
        ok: true,
        value: await this.service.activateInvitation(token, principal.provider, principal.subject),
      };
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
    sessionToken: string,
    correlationId: string,
    permission: Permission,
  ): Promise<AuthResponse<null>> {
    try {
      if (typeof sessionToken !== 'string' || typeof correlationId !== 'string')
        throw new AuthError('unauthorized');
      const context = await this.service.authenticate(sessionToken, correlationId);
      const granted = await this.accessResolver.resolvePermissions(context);
      await this.service.requirePermission(context, permission, granted);
      return { ok: true, value: null };
    } catch (error) {
      return errorResponse(error);
    }
  }
}
