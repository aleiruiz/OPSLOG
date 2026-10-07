import { describe, expect, it } from 'vitest';
import { makeDocument } from '../documents/fixtures';
import { makePolicy } from '../insurance/fixtures';
import { createMockAlertsStore, DEFAULT_RECIPIENTS } from './mockAlerts';
import type { Document, InsurancePolicy } from './types';

const clock = () => new Date('2026-10-06T12:00:00.000Z');

function store(documents: Document[] = [], policies: InsurancePolicy[] = []) {
  return createMockAlertsStore({
    documents: () => documents,
    policies: () => policies,
    now: clock,
  });
}
const list = async (s: ReturnType<typeof store>, query = {}) => {
  const result = await s.port.list(query);
  if (!result.ok) throw new Error(`list failed: ${result.error.status}`);
  return result.value;
};

describe('derived alerts', () => {
  it('derives expiring and expired alerts from live vehicle documents and policies, soonest first, then by source and id', async () => {
    const s = store(
      [
        makeDocument({ id: 'doc-b', expiresOn: '2026-10-20' }),
        makeDocument({ id: 'doc-a', expiresOn: '2026-10-20' }),
        makeDocument({ id: 'doc-old', expiresOn: '2026-09-01', typeCode: 'transport_permit' }),
      ],
      [makePolicy({ id: 'pol-1', endsOn: '2026-10-20', coverageType: 'third_party' })],
    );
    const page = await list(s);
    expect(page.items.map((item) => item.subjectId)).toEqual([
      'doc-old',
      'pol-1',
      'doc-a',
      'doc-b',
    ]);
    expect(page.items[0]).toEqual({
      key: 'vehicle_document:doc-old:2026-09-01',
      source: 'vehicle_document',
      subjectId: 'doc-old',
      vehicleId: 'veh-001',
      typeCode: 'transport_permit',
      dueOn: '2026-09-01',
      daysToExpiry: -35,
      severity: 'expired',
    });
    expect(page).toMatchObject({ total: 4, asOf: '2026-10-06', windowDays: 30, nextCursor: null });
    expect(page.items[1]).toMatchObject({
      source: 'insurance_policy',
      typeCode: 'third_party',
      daysToExpiry: 14,
    });
  });

  it('keeps the last day of the window and of the validity inclusive, and nothing beyond', async () => {
    const s = store([
      makeDocument({ id: 'doc-today', expiresOn: '2026-10-06' }),
      makeDocument({ id: 'doc-30', expiresOn: '2026-11-05' }),
      makeDocument({ id: 'doc-31', expiresOn: '2026-11-06' }),
      makeDocument({ id: 'doc-yesterday', expiresOn: '2026-10-05' }),
    ]);
    const page = await list(s);
    const bySubject = Object.fromEntries(page.items.map((item) => [item.subjectId, item]));
    expect(bySubject['doc-today']).toMatchObject({ daysToExpiry: 0, severity: 'expiring' });
    expect(bySubject['doc-30']).toMatchObject({ daysToExpiry: 30, severity: 'expiring' });
    expect(bySubject['doc-yesterday']).toMatchObject({ daysToExpiry: -1, severity: 'expired' });
    expect(bySubject['doc-31']).toBeUndefined();
  });

  it('ignores employee documents, archived records and documents without an expiry', async () => {
    const s = store(
      [
        makeDocument({
          id: 'doc-emp',
          ownerType: 'employee',
          ownerId: 'emp-001',
          expiresOn: '2026-10-07',
        }),
        makeDocument({
          id: 'doc-arch',
          expiresOn: '2026-10-07',
          archivedAt: '2026-10-01T00:00:00.000Z',
        }),
        makeDocument({ id: 'doc-none', expiresOn: null }),
      ],
      [
        makePolicy({
          id: 'pol-arch',
          endsOn: '2026-10-07',
          archivedAt: '2026-10-01T00:00:00.000Z',
        }),
      ],
    );
    expect((await list(s)).total).toBe(0);
  });

  it('filters by source, severity and vehicle, and pages with a cursor', async () => {
    const documents = Array.from({ length: 30 }, (_, index) =>
      makeDocument({
        id: `doc-${String(index + 1).padStart(3, '0')}`,
        ownerId: index % 2 === 0 ? 'veh-001' : 'veh-002',
        expiresOn: `2026-10-${String(index < 20 ? 7 : 1).padStart(2, '0')}`,
      }),
    );
    const s = store(documents, [
      makePolicy({ id: 'pol-1', endsOn: '2026-10-10', vehicleId: 'veh-002' }),
    ]);
    const first = await list(s);
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).toBe('mock:25');
    const second = await list(s, { cursor: first.nextCursor as string });
    expect(second.items).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    expect(await list(s, { source: 'insurance_policy' })).toMatchObject({ total: 1 });
    expect(await list(s, { severity: 'expired' })).toMatchObject({ total: 10 });
    expect(
      (await list(s, { vehicleId: 'veh-002' })).items.every((item) => item.vehicleId === 'veh-002'),
    ).toBe(true);
    expect(await list(s, { limit: 50 })).toMatchObject({ total: 31 });
  });

  it('rejects an invalid query with a uniform 400', async () => {
    const s = store();
    for (const query of [
      { limit: 10 },
      { cursor: 'nope' },
      { source: 'other' },
      { severity: 'soon' },
      { vehicleId: '../x' },
    ])
      expect(await s.port.list(query as never)).toMatchObject({
        ok: false,
        error: { status: 400, code: 'bad_request' },
      });
  });
});

describe('alert settings', () => {
  it('starts at the defaults in version 0, never saved', async () => {
    const s = store();
    expect(await s.port.settings()).toEqual({
      ok: true,
      value: {
        expiryWindowDays: 30,
        recipientRoles: DEFAULT_RECIPIENTS,
        version: 0,
        updatedBy: null,
        updatedAt: null,
      },
    });
  });

  it('saves a full replacement with the version of the last read and moves the version on', async () => {
    const s = store([makeDocument({ id: 'doc-20', expiresOn: '2026-10-26' })]);
    const saved = await s.port.saveSettings({
      version: 0,
      expiryWindowDays: 7,
      recipientRoles: ['viewer', 'admin'],
    });
    expect(saved).toMatchObject({
      ok: true,
      value: {
        expiryWindowDays: 7,
        recipientRoles: ['admin', 'viewer'],
        version: 1,
        updatedBy: 'user-admin',
      },
    });
    // A narrower window shrinks the alerts, and the page says which window it used.
    expect(await list(s)).toMatchObject({ total: 0, windowDays: 7 });
    expect(s.settings().version).toBe(1);
  });

  it('answers 409 stale_version to a save made on an old read, and keeps what is stored', async () => {
    const s = store();
    s.changeSettingsExternally({ expiryWindowDays: 21 });
    const stale = await s.port.saveSettings({
      version: 0,
      expiryWindowDays: 7,
      recipientRoles: ['admin'],
    });
    expect(stale).toMatchObject({ ok: false, error: { status: 409, code: 'stale_version' } });
    expect(s.settings()).toMatchObject({
      expiryWindowDays: 21,
      version: 1,
      updatedBy: 'user-sintetico-01',
    });
    // A version that does not exist yet is stale as well.
    expect(
      await s.port.saveSettings({ version: 5, expiryWindowDays: 7, recipientRoles: ['admin'] }),
    ).toMatchObject({
      error: { code: 'stale_version' },
    });
  });

  it('rejects anything but a complete, valid replacement with a uniform 400', async () => {
    const s = store();
    const valid = { version: 0, expiryWindowDays: 30, recipientRoles: ['admin'] };
    const bad: unknown[] = [
      { ...valid, version: -1 },
      { ...valid, version: 1.5 },
      { ...valid, version: '0' },
      { ...valid, expiryWindowDays: 0 },
      { ...valid, expiryWindowDays: 31 },
      { ...valid, expiryWindowDays: 2.5 },
      { ...valid, recipientRoles: [] },
      { ...valid, recipientRoles: ['admin', 'admin'] },
      { ...valid, recipientRoles: ['root'] },
      { ...valid, recipientRoles: 'admin' },
      { ...valid, tenantId: 'other' },
      { version: 0, expiryWindowDays: 30 },
    ];
    for (const input of bad)
      expect(await s.port.saveSettings(input as never)).toMatchObject({
        ok: false,
        error: { status: 400 },
      });
    expect(s.settings().version).toBe(0);
  });
});
