import {
  IdentityService,
  type MfaPort,
  type Permission,
  type SystemRole,
} from '../../../../packages/domain/identity/src/index.js';
import {
  InMemoryIdentityRepository,
  NodeCredentialAdapter,
  TotpAdapter,
} from '../../../../packages/platform/auth/src/index.js';

export class AuthApplication {
  public readonly repository = new InMemoryIdentityRepository();
  public readonly service: IdentityService;
  public constructor(mfa: MfaPort = new TotpAdapter()) {
    this.service = new IdentityService(this.repository, new NodeCredentialAdapter(), mfa);
  }
  public invite(
    actor: string,
    tenantId: string,
    email: string,
    now: number,
    roles: readonly SystemRole[] = [],
  ) {
    return this.service.invite(actor, tenantId, email, now, roles);
  }
  public login(email: string, password: string, tenantId: string, now: number, mfaCode?: string) {
    return this.service.authenticate(email, password, tenantId, now, mfaCode);
  }
  public authorize(userId: string, tenantId: string, permission: Permission, ownerId?: string) {
    return this.service.authorize(userId, tenantId, permission, ownerId);
  }
}
