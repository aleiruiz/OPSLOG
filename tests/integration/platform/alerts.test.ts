import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALERT_PERMISSIONS,
  AlertsApi,
  CompanySettingsApi,
  InMemorySettingsStore,
  MAX_ALERT_OFFSET,
  ROLE_PERMISSIONS,
  SETTINGS_PERMISSIONS,
  type AlertView,
  type PlatformResponse,
  type RoleName,
} from '../../../apps/api/composition/src/index.js';
import { AuthError } from '../../../packages/domain/identity/src/index.js';
import { AlertService } from '../../../packages/domain/alerts/src/index.js';
import {
  InMemoryDocumentStore,
  type DocumentStore,
} from '../../../packages/domain/documents/src/index.js';
import {
  InMemoryPolicyStore,
  type PolicyStore,
} from '../../../packages/domain/insurance/src/index.js';
import {
  SettingsService,
  type SettingsStore,
} from '../../../packages/domain/settings/src/index.js';
import { corr, createWorld, type Session, type World } from './world.js';

let world: World;
afterEach(() => {
  world.dispose();
  vi.restoreAllMocks();
});

interface Fixture {
  readonly a: Awaited<ReturnType<World['tenant']>>;
  readonly b: Awaited<ReturnType<World['tenant']>>;
  readonly roles: Readonly<Record<RoleName, Session>>;
  readonly adminB: Session;
  readonly vehicle: string;
  readonly vehicle2: string;
  readonly vehicleB: string;
}

const ok = <T>(result: PlatformResponse<T>): T => {
  if (!result.ok || result.value === undefined)
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
};

let serial = 0;
async function fixture(w: World): Promise<Fixture> {
  const a = await w.tenant('Empresa Alfa', 'subject-admin-a');
  const b = await w.tenant('Empresa Beta', 'subject-admin-b');
  const roles = {
    admin: a.admin,
    editor: await w.member(a.admin, 'editor', 'subject-editor-a'),
    viewer: await w.member(a.admin, 'viewer', 'subject-viewer-a'),
    auditor: await w.member(a.admin, 'auditor', 'subject-auditor-a'),
    pii_reader: await w.member(a.admin, 'pii_reader', 'subject-pii-a'),
  } as const;
  const vehicleOf = async (session: Session, areaId: string): Promise<string> => {
    serial += 1;
    return ok(
      await w.platform.vehicles.create(session.token, corr(), {
        economicNumber: `U-${serial}`,
        plate: `ABC${serial}`,
        vin: null,
        make: 'Toyota',
        model: 'Hilux',
        year: 2022,
        areaId,
        odometerKm: 10,
      }),
    ).id;
  };
  const areaA = ok(await w.platform.areas.create(a.admin.token, corr(), { name: 'Flota' })).id;
  const areaB = ok(await w.platform.areas.create(b.admin.token, corr(), { name: 'Flota' })).id;
  return {
    a,
    b,
    roles,
    adminB: b.admin,
    vehicle: await vehicleOf(a.admin, areaA),
    vehicle2: await vehicleOf(a.admin, areaA),
    vehicleB: await vehicleOf(b.admin, areaB),
  };
}

const document = async (
  w: World,
  session: Session,
  ownerId: string,
  expiresOn: string,
  typeCode = 'registration_card',
) =>
  ok(
    await w.platform.documents.create(session.token, corr(), {
      ownerType: 'vehicle',
      ownerId,
      typeCode,
      title: 'Documento de prueba',
      expiresOn,
    }),
  );

const policy = async (
  w: World,
  session: Session,
  vehicleId: string,
  endsOn: string,
  policyNumber = 'pol-001',
) =>
  ok(
    await w.platform.insurance.create(session.token, corr(), {
      vehicleId,
      insurer: 'Aseguradora Ficticia',
      policyNumber,
      coverageType: 'third_party',
      startsOn: '2025-01-01',
      endsOn,
    }),
  );

const SETTINGS = { expiryWindowDays: 7, recipientRoles: ['editor', 'admin'] };
const auditOf = (w: World, tenantId: string) =>
  w.audit.list(tenantId).filter((event) => event.entityType === 'company_settings');
const ids = (items: readonly AlertView[]): string[] => items.map((alert) => alert.subjectId);

describe('alerts derived through the platform', () => {
  it('derives alerts from the documents and policies stores as of the UTC date of the clock', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const edge = await document(world, admin, f.vehicle, '2026-10-06');
    const last = await document(world, admin, f.vehicle, '2026-11-05', 'technical_inspection');
    await document(world, admin, f.vehicle, '2026-11-06', 'transport_permit');
    const old = await document(world, admin, f.vehicle2, '2026-10-05', 'municipal_authorization');
    const ended = await policy(world, admin, f.vehicle2, '2026-10-05');
    await document(world, f.adminB, f.vehicleB, '2026-10-07');

    const slice = ok(await platform.alerts.list(admin.token, corr(), {}));
    expect(slice).toMatchObject({
      tenantId: f.a.tenantId,
      total: 4,
      asOf: '2026-10-06',
      windowDays: 30,
    });
    expect(slice.items.map((alert) => [alert.dueOn, alert.severity, alert.daysToExpiry])).toEqual([
      ['2026-10-05', 'expired', -1],
      ['2026-10-05', 'expired', -1],
      ['2026-10-06', 'expiring', 0],
      ['2026-11-05', 'expiring', 30],
    ]);
    expect(new Set(ids(slice.items))).toEqual(new Set([old.id, ended.id, edge.id, last.id]));
    expect(slice.items.map((alert) => alert.source).slice(0, 2)).toEqual([
      'insurance_policy',
      'vehicle_document',
    ]);
    // The same calendar day later: the edge document is expired, the 30-day one is 29 days away.
    world.advance(12 * 3_600_000);
    const later = await world.signIn('subject-admin-a', f.a.tenantId);
    const next = ok(await platform.alerts.list(later.token, corr(), {}));
    expect(next.asOf).toBe('2026-10-07');
    expect(next.items.find((alert) => alert.subjectId === last.id)?.daysToExpiry).toBe(29);
    expect(next.items.find((alert) => alert.subjectId === edge.id)?.severity).toBe('expired');
    // Another company sees only its own.
    const laterB = await world.signIn('subject-admin-b', f.b.tenantId);
    expect(ok(await platform.alerts.list(laterB.token, corr(), {})).total).toBe(1);
  });

  it('follows the company window and archives, and does not write anything', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const near = await document(world, admin, f.vehicle, '2026-10-10');
    const far = await policy(world, admin, f.vehicle, '2026-10-30');
    const archived = await document(world, admin, f.vehicle2, '2026-10-08', 'technical_inspection');
    ok(await platform.documents.archive(admin.token, corr(), archived.id, 1));
    const auditBefore = world.audit.list(f.a.tenantId).length;
    expect(ids(ok(await platform.alerts.list(admin.token, corr(), {})).items)).toEqual([
      near.id,
      far.id,
    ]);
    ok(await platform.companySettings.update(admin.token, corr(), 0, SETTINGS));
    expect(ids(ok(await platform.alerts.list(admin.token, corr(), {})).items)).toEqual([near.id]);
    expect(ok(await platform.alerts.list(admin.token, corr(), {})).windowDays).toBe(7);
    // Reads add no audit event; only the settings write did.
    expect(world.audit.list(f.a.tenantId).length - auditBefore).toBe(1);
  });

  it('restarts the cycle when a document is renewed (new key) and drops it out of the window', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    const doc = await document(world, admin, f.vehicle, '2026-10-10');
    const before = ok(await platform.alerts.list(admin.token, corr(), {})).items[0] as AlertView;
    ok(await platform.documents.renew(admin.token, corr(), doc.id, 1, { expiresOn: '2026-10-20' }));
    const after = ok(await platform.alerts.list(admin.token, corr(), {})).items[0] as AlertView;
    expect(after.key).not.toBe(before.key);
    expect(after.dueOn).toBe('2026-10-20');
    ok(await platform.documents.renew(admin.token, corr(), doc.id, 2, { expiresOn: '2028-01-01' }));
    expect(ok(await platform.alerts.list(admin.token, corr(), {})).total).toBe(0);
  });

  it('bounds the offset and rejects malformed queries without echoing them', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    for (const query of [
      { offset: MAX_ALERT_OFFSET + 1 },
      { limit: 0 },
      { source: 'ECO-9999-secreto' },
      { severity: 'ECO-9999-secreto' },
      { vehicleId: 'ECO-9999 secreto' },
    ]) {
      const result = await platform.alerts.list(admin.token, corr(), query);
      expect(result.error).toMatchObject({ code: 'invalid_input', status: 400 });
      expect(JSON.stringify(result)).not.toContain('ECO-9999');
    }
    expect((await platform.alerts.list(admin.token, corr(), { offset: MAX_ALERT_OFFSET })).ok).toBe(
      true,
    );
  });
});

describe('company settings through the platform', () => {
  it('reads the defaults, saves with the version of the last read and audits without values', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    expect(ok(await platform.companySettings.get(admin.token, corr()))).toEqual({
      expiryWindowDays: 30,
      recipientRoles: ['admin', 'editor'],
      version: 0,
      updatedBy: null,
      updatedAt: null,
    });
    const saved = ok(await platform.companySettings.update(admin.token, corr(), 0, SETTINGS));
    expect(saved).toEqual({
      expiryWindowDays: 7,
      recipientRoles: ['admin', 'editor'],
      version: 1,
      updatedBy: `user-${admin.identityId}`,
      updatedAt: '2026-10-06T12:00:00.000Z',
    });
    expect(Object.keys(saved).sort()).toEqual(
      ['expiryWindowDays', 'recipientRoles', 'version', 'updatedBy', 'updatedAt'].sort(),
    );
    expect(ok(await platform.companySettings.get(f.roles.viewer.token, corr()))).toEqual(saved);
    ok(
      await platform.companySettings.update(admin.token, corr(), 1, {
        expiryWindowDays: 14,
        recipientRoles: ['auditor'],
      }),
    );
    const events = auditOf(world, f.a.tenantId);
    expect(events.map((event) => [event.action, event.entityId])).toEqual([
      ['company_settings.updated', f.a.tenantId],
      ['company_settings.updated', f.a.tenantId],
    ]);
    const text = JSON.stringify(events);
    for (const fragment of ['auditor', '"14"', 'expiryWindowDays', 'recipientRoles', 'editor'])
      expect(text).not.toContain(fragment);
    expect(auditOf(world, f.b.tenantId)).toHaveLength(0);
  });

  it('refuses stale and malformed writes without auditing or changing anything', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const admin = f.roles.admin;
    ok(await platform.companySettings.update(admin.token, corr(), 0, SETTINGS));
    for (const version of [0, 5])
      expect(
        (await platform.companySettings.update(admin.token, corr(), version, SETTINGS)).error,
      ).toMatchObject({ code: 'stale_version', status: 409 });
    for (const [version, input] of [
      [1, { ...SETTINGS, tenantId: f.b.tenantId }],
      [1, { expiryWindowDays: 31, recipientRoles: ['admin'] }],
      [1, { expiryWindowDays: 7, recipientRoles: ['ECO-9999-secreto'] }],
      [1, 'ECO-9999-secreto'],
      ['ECO-9999-secreto', SETTINGS],
    ] as const) {
      const result = await platform.companySettings.update(admin.token, corr(), version, input);
      expect(result.error).toMatchObject({ code: 'invalid_input', status: 400 });
      expect(JSON.stringify(result)).not.toContain('ECO-9999');
    }
    expect(ok(await platform.companySettings.get(admin.token, corr())).version).toBe(1);
    expect(auditOf(world, f.a.tenantId)).toHaveLength(1);
  });

  it('lets exactly one of many concurrent writes of the same version win', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const results = await Promise.all(
      [1, 2, 3, 4].map((days) =>
        platform.companySettings.update(f.roles.admin.token, corr(), 0, {
          ...SETTINGS,
          expiryWindowDays: days,
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    for (const result of results.filter((candidate) => !candidate.ok))
      expect(result.error?.code).toBe('stale_version');
    expect(auditOf(world, f.a.tenantId)).toHaveLength(1);
  });

  it('keeps each company settings apart and uses the injected store', async () => {
    const store = new InMemorySettingsStore();
    world = createWorld({ adapters: { settings: store } });
    const f = await fixture(world);
    ok(await world.platform.companySettings.update(f.roles.admin.token, corr(), 0, SETTINGS));
    expect(await store.find(f.a.tenantId)).toMatchObject({ tenantId: f.a.tenantId, version: 1 });
    expect(await store.find(f.b.tenantId)).toBeNull();
    expect(ok(await world.platform.companySettings.get(f.adminB.token, corr())).version).toBe(0);
    expect(
      (await world.platform.companySettings.update(f.adminB.token, corr(), 1, SETTINGS)).error
        ?.code,
    ).toBe('stale_version');
  });
});

const GRANTS = ROLE_PERMISSIONS;
describe('role matrix', () => {
  for (const role of Object.keys(GRANTS) as RoleName[])
    it(`${role}: reads alerts and settings with view; writes settings only with manage_config`, async () => {
      world = createWorld();
      const f = await fixture(world);
      const session = f.roles[role];
      const canWrite = GRANTS[role].includes('manage_config');
      expect((await world.platform.alerts.list(session.token, corr(), {})).ok).toBe(true);
      expect((await world.platform.companySettings.get(session.token, corr())).ok).toBe(true);
      const write = await world.platform.companySettings.update(session.token, corr(), 0, SETTINGS);
      if (canWrite) {
        expect(write.ok).toBe(true);
        expect(auditOf(world, f.a.tenantId)).toHaveLength(1);
      } else {
        expect(write.error).toMatchObject({ code: 'forbidden', status: 403 });
        expect(write.value).toBeUndefined();
        expect(auditOf(world, f.a.tenantId)).toHaveLength(0);
        expect(ok(await world.platform.companySettings.get(session.token, corr())).version).toBe(0);
      }
    });

  it('asks the authorizer for the documented permissions on every operation', async () => {
    const asked: string[][] = [];
    const authorize = async (_token: string, _correlation: string, required: readonly string[]) => {
      asked.push([...required]);
      throw new AuthError('forbidden');
    };
    const alerts = new AlertsApi({
      service: new AlertService(
        {
          vehicle_document: { due: async () => ({ items: [], total: 0 }) },
          insurance_policy: { due: async () => ({ items: [], total: 0 }) },
        },
        { expiryWindowDays: async () => 30 },
      ),
      authorize: authorize as never,
    });
    const settings = new CompanySettingsApi({
      service: new SettingsService(new InMemorySettingsStore()),
      authorize: authorize as never,
      audit: () => undefined,
    });
    await alerts.list('t', 'c', {});
    await settings.get('t', 'c');
    await settings.update('t', 'c', 0, {});
    expect(asked).toEqual([['view'], ['view'], ['manage_config']]);
    expect(ALERT_PERMISSIONS).toEqual({ read: ['view'] });
    expect(SETTINGS_PERMISSIONS).toEqual({ read: ['view'], update: ['manage_config'] });
  });
});

describe('sessions and tenants gate every call', () => {
  it('refuses a revoked session, a removed member and a suspended tenant, without writing', async () => {
    world = createWorld();
    const { platform } = world;
    const f = await fixture(world);
    const calls = (s: Session) => [
      platform.alerts.list(s.token, corr(), {}),
      platform.companySettings.get(s.token, corr()),
      platform.companySettings.update(s.token, corr(), 0, SETTINGS),
    ];
    const denied = async (s: Session) => {
      for (const result of await Promise.all(calls(s)))
        expect(result.error).toMatchObject({ code: 'unauthorized', status: 401 });
    };
    await platform.signOut(f.roles.viewer.token);
    await denied(f.roles.viewer);
    await platform.removeMember(f.roles.admin.token, corr(), f.roles.editor.identityId);
    await denied(f.roles.editor);
    await platform.suspendTenant(f.a.tenantId);
    await denied(f.roles.admin);
    await platform.reactivateTenant(f.a.tenantId);
    expect(ok(await platform.companySettings.get(f.roles.admin.token, corr())).version).toBe(0);
    expect(auditOf(world, f.a.tenantId)).toHaveLength(0);
    for (const token of ['', 'not-a-session', 'x'.repeat(2000)])
      expect((await platform.alerts.list(token, corr(), {})).error?.code).toBe('unauthorized');
  });
});

describe('adapters and failures', () => {
  it('reads documents and policies of the session tenant only', async () => {
    const documents = new InMemoryDocumentStore();
    const policies = new InMemoryPolicyStore();
    const seen: string[] = [];
    const spyDocuments: DocumentStore = {
      insert: (d, r) => documents.insert(d, r),
      find: (t, id) => documents.find(t, id),
      list: (t, filter, window) => {
        seen.push(`documents:${t}`);
        return documents.list(t, filter, window);
      },
      replace: (n, e, r) => documents.replace(n, e, r),
      revisions: (t, d, w) => documents.revisions(t, d, w),
    };
    const spyPolicies: PolicyStore = {
      insert: (p, r) => policies.insert(p, r),
      find: (t, id) => policies.find(t, id),
      list: (t, filter, window) => {
        seen.push(`policies:${t}`);
        return policies.list(t, filter, window);
      },
      replace: (n, e, r) => policies.replace(n, e, r),
      revisions: (t, p, w) => policies.revisions(t, p, w),
    };
    world = createWorld({ adapters: { documents: spyDocuments, insurance: spyPolicies } });
    const f = await fixture(world);
    await document(world, f.roles.admin, f.vehicle, '2026-10-10');
    ok(await world.platform.alerts.list(f.roles.admin.token, corr(), {}));
    ok(await world.platform.alerts.list(f.adminB.token, corr(), { vehicleId: f.vehicleB }));
    expect(seen).toEqual([
      `documents:${f.a.tenantId}`,
      `policies:${f.a.tenantId}`,
      `documents:${f.b.tenantId}`,
      `policies:${f.b.tenantId}`,
    ]);
  });

  it('turns an infrastructure failure into a generic 500 without leaking its message', async () => {
    const inner = new InMemorySettingsStore();
    const broken: SettingsStore = {
      find: () => {
        throw new Error('connection to db-prod.internal refused for ECO-FICTICIA-1');
      },
      insert: (s) => inner.insert(s),
      replace: (n, e) => inner.replace(n, e),
    };
    world = createWorld({ adapters: { settings: broken } });
    const f = await fixture(world);
    const expected = {
      ok: false,
      error: { code: 'internal_error', status: 500, message: 'Request failed' },
    };
    expect(await world.platform.companySettings.get(f.roles.admin.token, corr())).toEqual(expected);
    // Alerts need the window, so a settings failure fails them the same way.
    expect(await world.platform.alerts.list(f.roles.admin.token, corr(), {})).toEqual(expected);
    expect(auditOf(world, f.a.tenantId)).toHaveLength(0);
  });

  it('maps identity failures that are neither auth nor permission to a generic error, and invalid input to a 400', async () => {
    world = createWorld();
    const { platform } = world;
    await fixture(world);
    platform.identity.authenticate = async () => {
      throw new AuthError('conflict');
    };
    expect((await platform.alerts.list('t', corr(), {})).error).toMatchObject({
      code: 'internal_error',
      status: 500,
    });
    expect((await platform.companySettings.get('t', corr())).error).toMatchObject({
      code: 'internal_error',
      status: 500,
    });
    platform.identity.authenticate = async () => {
      throw new AuthError('invalid_input');
    };
    expect((await platform.alerts.list('t', corr(), {})).error).toMatchObject({
      code: 'invalid_input',
      status: 400,
    });
    expect((await platform.companySettings.get('t', corr())).error).toMatchObject({
      code: 'invalid_input',
      status: 400,
    });
  });
});
