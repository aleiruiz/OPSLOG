export type IdentityStatus = 'pending' | 'active' | 'revoked';

export type MfaStatus = 'disabled' | 'optional' | 'required';

export type Permission =
  | 'manage_users'
  | 'manage_config'
  | 'view'
  | 'create'
  | 'edit'
  | 'delete'
  | 'export'
  | 'view_pii'
  | 'view_costs'
  | 'view_audit'
  | 'approve'
  | 'reopen'
  | 'incidents:report';

export interface ActorRef {
  readonly subject: string;
  readonly kind: 'user' | 'system';
}

export interface TenantContext {
  readonly tenantId: string;
  readonly actor: ActorRef;
  readonly authorizationVersion: number;
  readonly correlationId: string;
}

export interface ExternalIdentity {
  readonly id: string;
  readonly provider: string;
  readonly subject: string;
  readonly identityId: string;
  readonly status: IdentityStatus;
  readonly createdAt: Date;
}

export interface Identity {
  readonly id: string;
  readonly status: IdentityStatus;
  readonly mfa: MfaStatus;
  readonly authorizationVersion: number;
  readonly createdAt: Date;
}

export interface Invitation {
  readonly id: string;
  readonly tenantId: string;
  readonly identityId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface Membership {
  readonly id: string;
  readonly tenantId: string;
  readonly identityId: string;
  readonly status: 'pending' | 'active' | 'revoked';
  readonly createdAt: Date;
  readonly activatedAt: Date | null;
}

export interface InvitationActivation {
  readonly identity: Identity;
  readonly membership: Membership;
}

export interface RecoveryRequest {
  readonly id: string;
  readonly identityId: string;
  readonly tokenHash: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly supersededAt?: Date | null;
}

export interface Session {
  readonly id: string;
  readonly identityId: string;
  readonly tenantId: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly authorizationVersion: number;
}
