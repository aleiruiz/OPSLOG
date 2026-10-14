import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { DataSource, QueryRunner, Table } from 'typeorm';
import {
  CONTROL_PLANE_ENTITIES,
  CONTROL_PLANE_TABLES,
  CreateControlPlane2026101800010,
  controlPlaneSchema,
} from './control-plane-schema.js';
import { TypeOrmControlPlaneStore } from './control-plane-store.js';
import { createIdentityDataSource } from './data-source.js';

type Call = { entity: string; method: string; args: unknown[] };

/** DataSource double that records what the store asks of each repository and answers canned rows. */
function fakeSource(options: { username?: string; type?: string; synchronize?: boolean } = {}) {
  const calls: Call[] = [];
  const answers: Record<string, unknown> = {};
  const repositoryOf = (schema: { options: { name: string } }) =>
    new Proxy(
      {},
      {
        get:
          (_target, method: string) =>
          async (...args: unknown[]) => {
            calls.push({ entity: schema.options.name, method, args });
            const key = `${schema.options.name}.${method}`;
            return key in answers ? answers[key] : [];
          },
      },
    );
  const source = {
    options: {
      type: options.type ?? 'mysql',
      synchronize: options.synchronize ?? false,
      username: options.username ?? 'opslog_identity_app',
    },
    getRepository: repositoryOf,
  } as unknown as DataSource;
  return { source, calls, answers };
}

describe('TypeOrmControlPlaneStore', () => {
  it('requires MySQL without synchronize and the restricted runtime account', () => {
    expect(() => new TypeOrmControlPlaneStore(fakeSource({ type: 'postgres' }).source)).toThrow(
      'requires MySQL',
    );
    expect(() => new TypeOrmControlPlaneStore(fakeSource({ synchronize: true }).source)).toThrow(
      'requires MySQL',
    );
    expect(() => new TypeOrmControlPlaneStore(fakeSource({ username: 'root' }).source)).toThrow(
      'restricted runtime account',
    );
    expect(
      () => new TypeOrmControlPlaneStore(fakeSource({ username: 'opslog_control_x' }).source),
    ).not.toThrow();
  });

  it('reads and writes plain records through the control-plane tables', async () => {
    const { source, calls, answers } = fakeSource();
    const store = new TypeOrmControlPlaneStore(source);
    const at = new Date('2026-10-06T12:00:00.000Z');
    answers['ControlSessionRow.findOneBy'] = {
      id: 's1',
      tenantId: 't1',
      subjectId: 'u1',
      authorizationVersion: 2,
      expiresAt: at,
      revoked: 1,
    };
    answers['ControlSessionRow.delete'] = { affected: 3 };

    await store.listTenants();
    await store.insertTenant({ id: 't1', name: 'N', status: 'active', createdAt: at });
    await store.updateTenant('t1', { status: 'suspended' });
    await store.listMemberships();
    await store.upsertMembership({ tenantId: 't1', subjectId: 'u1', version: 2, status: 'active' });
    await store.upsertSession({
      id: 's1',
      tenantId: 't1',
      subjectId: 'u1',
      authorizationVersion: 2,
      expiresAt: at,
      revoked: true,
    });
    expect(await store.findSession('s1')).toEqual({
      id: 's1',
      tenantId: 't1',
      subjectId: 'u1',
      authorizationVersion: 2,
      expiresAt: at,
      revoked: true,
    });
    expect(await store.purgeSessions(at)).toBe(3);
    await store.listSettings();
    await store.upsertSettings({ tenantId: 't1', name: 'N', mfa: 'optional', sessionIdleHours: 4 });

    expect(calls.map((call) => `${call.entity}.${call.method}`)).toEqual([
      'ControlTenantRow.find',
      'ControlTenantRow.insert',
      'ControlTenantRow.update',
      'ControlMembershipRow.find',
      'ControlMembershipRow.upsert',
      'ControlSessionRow.upsert',
      'ControlSessionRow.findOneBy',
      'ControlSessionRow.delete',
      'ControlSettingsRow.find',
      'ControlSettingsRow.upsert',
    ]);
    expect(calls[5]?.args).toEqual([expect.objectContaining({ revoked: 1, id: 's1' }), ['id']]);
    expect(calls[4]?.args[1]).toEqual(['tenantId', 'subjectId']);
  });

  it('answers null for an unknown session and zero when nothing was purged', async () => {
    const { source, answers } = fakeSource();
    const store = new TypeOrmControlPlaneStore(source);
    answers['ControlSessionRow.findOneBy'] = null;
    answers['ControlSessionRow.delete'] = {};
    expect(await store.findSession('missing')).toBeNull();
    expect(await store.purgeSessions(new Date())).toBe(0);
  });
});

describe('control-plane schema', () => {
  it('registers four tables behind the identity data source factories', () => {
    expect(CONTROL_PLANE_ENTITIES).toHaveLength(4);
    expect(Object.values(CONTROL_PLANE_TABLES)).toEqual([
      'opslog_control_tenants',
      'opslog_control_memberships',
      'opslog_control_sessions',
      'opslog_control_tenant_settings',
    ]);
    const source = createIdentityDataSource({
      host: 'h',
      port: 3306,
      database: 'opslog_t_x',
      username: 'opslog_identity_app',
      password: 'p',
      ...controlPlaneSchema,
    });
    expect(source.options.migrations).toContain(CreateControlPlane2026101800010);
    expect(source.entityMetadatas).toBeDefined();
  });

  it('creates the four tables and drops them in reverse order', async () => {
    const created: string[] = [];
    const dropped: string[] = [];
    const runner = {
      createTable: async (table: Table) => void created.push(table.name),
      dropTable: async (name: string) => void dropped.push(name),
    } as unknown as QueryRunner;
    const migration = new CreateControlPlane2026101800010();
    await migration.up(runner);
    await migration.down(runner);
    expect(created).toEqual(Object.values(CONTROL_PLANE_TABLES));
    expect(dropped).toEqual([...Object.values(CONTROL_PLANE_TABLES)].reverse());
  });
});
