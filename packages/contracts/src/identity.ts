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
  | 'incidents:report'
  | 'incidents:approve'
  | 'incidents:view'
  | 'incidents:create'
  | 'incidents:edit'
  | 'incidents:close'
  | 'incidents:reopen'
  | 'incidents:view_costs';
export type ActorKind = 'user' | 'api_key' | 'system';
export interface ActorRef {
  subject: string;
  kind: ActorKind;
}
export interface TenantContext {
  readonly tenantId: string;
  readonly actor: ActorRef;
  readonly authorizationVersion: number;
  readonly correlationId: string;
}
