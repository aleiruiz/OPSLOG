import { describe, expect, it } from 'vitest';
import { BATCH_CHUNK, chunksOf } from './batch.js';
import { InMemoryIncidentStore } from './store.js';
import type { Incident } from './types.js';

const base: Incident = {
  id: 'i1',
  tenantId: 'tenant-a',
  folio: 'SIN-2026-000001',
  status: 'reported',
  version: 1,
  cycle: 1,
  reopenCount: 0,
  type: 'collision',
  severity: 'high',
  vehicleId: 'v1',
  areaId: 'area-1',
  driverId: null,
  noDriverReason: null,
  occurredAt: null,
  occurredOn: null,
  location: null,
  description: 'texto libre',
  vehicleOperable: null,
  damage: { description: null, zones: [] },
  noPhotoJustification: null,
  coverageStatus: 'unknown',
  policySnapshot: null,
  reportedAt: '2026-10-02T10:00:00.000Z',
  reportedBy: null,
  responsibleId: null,
  insurerName: null,
  claimNumber: null,
  adjusterName: null,
  adjusterContact: null,
  insurerReportedOn: null,
  insurerResult: null,
  rejectionReason: null,
  appealNote: null,
  noInsuranceReason: null,
  costAssumed: null,
  resolutionSummary: null,
  totalLoss: null,
  vehicleStatusDecision: null,
  resolvedAt: null,
  assumptionApproval: null,
  closeApproval: null,
  closedAt: null,
  closedBy: null,
  cancelReason: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  createdBy: 'u1',
  updatedAt: '2026-10-01T00:00:00.000Z',
  updatedBy: 'u1',
};

const put = (
  store: InMemoryIncidentStore,
  patch: Partial<Incident>,
  resolveAt: string | null = null,
) =>
  store.apply({
    incident: { ...base, ...patch },
    expectedVersion: null,
    folioYear: 2026,
    transitions: resolveAt
      ? [
          {
            command: 'resolve',
            from: null,
            to: 'resolved',
            actorId: 'u1',
            comment: null,
            occurredAt: resolveAt,
            changedFields: [],
            before: null,
          },
        ]
      : [],
    auditActions: ['test'],
    events: [],
  });

describe('InMemoryIncidentStore dashboard reads', () => {
  it('lists open cases of the tenant and areas, leaving drafts and terminal ones out', async () => {
    const store = new InMemoryIncidentStore();
    await put(store, { id: 'a', folio: 'SIN-2026-000001' });
    await put(store, { id: 'b', folio: 'SIN-2026-000002', status: 'draft' });
    await put(store, { id: 'c', folio: 'SIN-2026-000003', status: 'closed' });
    await put(store, { id: 'd', folio: 'SIN-2026-000004', areaId: 'area-2' });
    await put(store, { id: 'e', folio: 'SIN-2026-000005', tenantId: 'tenant-b' });
    const ids = async (areas: readonly string[] | null) =>
      (await store.analyticsOpenCases('tenant-a', areas)).map((i) => i.id).sort();
    expect(await ids(null)).toEqual(['a', 'd']);
    expect(await ids(['area-2'])).toEqual(['d']);
    expect(await ids([])).toEqual([]);
  });

  it('reads report, first resolution and closure inside [from, to), reopened cases by timeline', async () => {
    const store = new InMemoryIncidentStore();
    await put(store, { id: 'a', folio: 'SIN-2026-000001', resolvedAt: '2026-10-03T10:00:00.000Z' });
    await put(
      store,
      {
        id: 'b',
        folio: 'SIN-2026-000002',
        cycle: 2,
        reportedAt: '2026-09-01T00:00:00.000Z',
        resolvedAt: '2026-11-20T00:00:00.000Z',
      },
      '2026-10-05T10:00:00.000Z',
    );
    await put(store, { id: 'c', folio: 'SIN-2026-000003', cycle: 2, reportedAt: null });
    await put(store, { id: 'x', folio: 'SIN-2026-000004', areaId: 'area-2' });
    const window = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' };
    const rows = await store.analyticsTimeline('tenant-a', ['area-1'], window);
    expect(rows).toEqual([
      {
        reportedAt: '2026-10-02T10:00:00.000Z',
        firstResolvedAt: '2026-10-03T10:00:00.000Z',
        closedAt: null,
      },
      {
        reportedAt: '2026-09-01T00:00:00.000Z',
        firstResolvedAt: '2026-10-05T10:00:00.000Z',
        closedAt: null,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain('texto libre');
    expect(await store.analyticsTimeline('tenant-a', null, window)).toHaveLength(3);
    expect(
      await store.analyticsTimeline('tenant-a', null, {
        from: '2026-12-01T00:00:00.000Z',
        to: '2026-12-02T00:00:00.000Z',
      }),
    ).toEqual([]);
  });
});

describe('InMemoryIncidentStore batch reads', () => {
  it('answers getMany and historyMany like get and history, for the tenant only', async () => {
    const store = new InMemoryIncidentStore();
    await put(store, { id: 'a', folio: 'SIN-2026-000001' }, '2026-10-05T10:00:00.000Z');
    await put(store, { id: 'b', folio: 'SIN-2026-000002' });
    await put(store, { id: 'c', folio: 'SIN-2026-000003', tenantId: 'tenant-b' });
    const ids = ['a', 'b', 'c', 'a', 'missing'];
    const many = await store.getMany('tenant-a', ids);
    expect(many.map((i) => i.id).sort()).toEqual(['a', 'b']);
    for (const incident of many) expect(incident).toEqual(await store.get('tenant-a', incident.id));
    const histories = await store.historyMany('tenant-a', ids);
    // `b` has no entries and `c` belongs to another tenant: both are absent.
    expect([...histories.keys()]).toEqual(['a']);
    expect(histories.get('a')).toEqual(await store.history('tenant-a', 'a'));
    // The answers are copies.
    (many[0] as { version: number }).version = 99;
    expect((await store.get('tenant-a', 'a'))?.version).toBe(1);
  });

  it('chunksOf drops repeated ids and keeps each list within the size', () => {
    expect(chunksOf(['a', 'b', 'a', 'c', 'd'], 2)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(chunksOf([])).toEqual([]);
    const many = Array.from({ length: BATCH_CHUNK * 2 + 1 }, (_, i) => `id-${i}`);
    expect(chunksOf(many).map((c) => c.length)).toEqual([BATCH_CHUNK, BATCH_CHUNK, 1]);
  });
});
