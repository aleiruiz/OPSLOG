import 'reflect-metadata';
import { LessThan, type DataSource } from 'typeorm';
import { IDENTITY_RUNTIME_ACCOUNT } from './data-source.js';
import {
  ControlMembershipRowSchema,
  ControlSessionRowSchema,
  ControlSettingsRowSchema,
  ControlTenantRowSchema,
} from './control-plane-schema.js';

export interface ControlTenantRecord {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly createdAt: Date;
}
export interface ControlMembershipRecord {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly version: number;
  readonly status: string;
}
export interface ControlSessionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly authorizationVersion: number;
  readonly expiresAt: Date;
  readonly revoked: boolean;
}
export interface ControlSettingsRecord {
  readonly tenantId: string;
  readonly name: string;
  readonly mfa: string;
  readonly sessionIdleHours: number;
}

/**
 * Durable rows of the control plane of a single-company deployment: the tenant, the membership
 * projection, the mirrored sessions and the company settings. Plain records in and out; the
 * domain meaning (statuses, the monotonic version rule) belongs to the caller. It uses the
 * identity runtime account, so it only ever reads and writes rows (no DDL).
 */
export class TypeOrmControlPlaneStore {
  public constructor(private readonly dataSource: DataSource) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Control plane store requires MySQL with synchronize disabled');
    const username = dataSource.options.username;
    if (typeof username !== 'string' || !IDENTITY_RUNTIME_ACCOUNT.test(username))
      throw new Error('Control plane store requires its restricted runtime account');
  }

  public listTenants(): Promise<readonly ControlTenantRecord[]> {
    return this.dataSource
      .getRepository(ControlTenantRowSchema)
      .find({ order: { createdAt: 'ASC' } });
  }

  public async insertTenant(tenant: ControlTenantRecord): Promise<void> {
    await this.dataSource.getRepository(ControlTenantRowSchema).insert(tenant);
  }

  public async updateTenant(
    id: string,
    changes: { readonly name?: string; readonly status?: string },
  ): Promise<void> {
    await this.dataSource.getRepository(ControlTenantRowSchema).update({ id }, { ...changes });
  }

  public listMemberships(): Promise<readonly ControlMembershipRecord[]> {
    return this.dataSource.getRepository(ControlMembershipRowSchema).find();
  }

  public async upsertMembership(membership: ControlMembershipRecord): Promise<void> {
    await this.dataSource
      .getRepository(ControlMembershipRowSchema)
      .upsert({ ...membership }, ['tenantId', 'subjectId']);
  }

  public async upsertSession(session: ControlSessionRecord): Promise<void> {
    await this.dataSource
      .getRepository(ControlSessionRowSchema)
      .upsert({ ...session, revoked: session.revoked ? 1 : 0 }, ['id']);
  }

  public async findSession(id: string): Promise<ControlSessionRecord | null> {
    const row = await this.dataSource.getRepository(ControlSessionRowSchema).findOneBy({ id });
    return row ? { ...row, revoked: row.revoked !== 0 } : null;
  }

  /** Deletes the mirrored sessions that expired before `before`; returns how many. */
  public async purgeSessions(before: Date): Promise<number> {
    const result = await this.dataSource
      .getRepository(ControlSessionRowSchema)
      .delete({ expiresAt: LessThan(before) });
    return result.affected ?? 0;
  }

  public listSettings(): Promise<readonly ControlSettingsRecord[]> {
    return this.dataSource.getRepository(ControlSettingsRowSchema).find();
  }

  public async upsertSettings(settings: ControlSettingsRecord): Promise<void> {
    await this.dataSource
      .getRepository(ControlSettingsRowSchema)
      .upsert({ ...settings }, ['tenantId']);
  }
}
