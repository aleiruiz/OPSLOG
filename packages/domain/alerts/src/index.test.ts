import { describe, expect, it } from 'vitest';
import {
  ALERT_SEVERITIES,
  ALERT_SOURCES,
  AlertError,
  AlertService,
  MAX_ALERT_OFFSET,
  alertOf,
  isAlertSeverity,
  isAlertSource,
  scopeOf,
  type AlertCandidate,
  type AlertScope,
  type AlertSource,
  type AlertSourceKind,
} from './index.js';
import { expiryOf, matchesExpiry } from '../../documents/src/index.js';

const NOW = new Date('2026-10-06T23:59:59.000Z');
const TODAY = '2026-10-06';
const A = 'tenant-a';

const candidate = (subjectId: string, dueOn: string, vehicleId = 'veh-1'): AlertCandidate => ({
  subjectId,
  vehicleId,
  typeCode: 'registration_card',
  dueOn,
});

/** A source over a list: honours the scope the way the real stores do (tenant, vehicle, expiry range) and orders by date then id. */
function source(rows: Record<string, readonly AlertCandidate[]>) {
  const calls: { tenantId: string; scope: AlertScope; offset: number; limit: number }[] = [];
  const port: AlertSource = {
    async due(tenantId, scope, window) {
      calls.push({ tenantId, scope, ...window });
      const matching = [...(rows[tenantId] ?? [])]
        .filter(
          (row) =>
            (scope.vehicleId === undefined || row.vehicleId === scope.vehicleId) &&
            matchesExpiry(row.dueOn, scope.expiry),
        )
        .sort((a, b) =>
          a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : a.subjectId < b.subjectId ? -1 : 1,
        );
      return {
        items: matching.slice(window.offset, window.offset + window.limit),
        total: matching.length,
      };
    },
  };
  return { port, calls };
}

const build = (
  documents: Record<string, readonly AlertCandidate[]>,
  policies: Record<string, readonly AlertCandidate[]> = {},
  windowDays = 30,
) => {
  const docs = source(documents);
  const pols = source(policies);
  const reads: string[] = [];
  const service = new AlertService(
    { vehicle_document: docs.port, insurance_policy: pols.port },
    {
      expiryWindowDays: async (tenantId) => {
        reads.push(tenantId);
        return windowDays;
      },
    },
    { now: () => NOW },
  );
  return { service, docs, pols, reads };
};

const code = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    await work();
  } catch (error) {
    return error instanceof AlertError ? error.code : error;
  }
  return 'resolved';
};

describe('constants and helpers', () => {
  it('exposes guards for sources and severities', () => {
    expect(ALERT_SOURCES.every(isAlertSource)).toBe(true);
    expect(ALERT_SEVERITIES.every(isAlertSeverity)).toBe(true);
    expect(isAlertSource('x')).toBe(false);
    expect(isAlertSeverity(1)).toBe(false);
  });

  it('derives the scope of a severity as of the UTC date, inclusive of the last valid day', () => {
    expect(scopeOf('expired', TODAY, 30)).toEqual({
      status: 'expired',
      from: TODAY,
      until: '2026-11-05',
    });
    expect(scopeOf('expiring', TODAY, 7)).toEqual({
      status: 'expiring',
      from: TODAY,
      until: '2026-10-13',
    });
    expect(scopeOf(undefined, TODAY, 30)).toEqual({
      status: 'expiring',
      from: '1950-01-01',
      until: '2026-11-05',
    });
  });

  it('derives an alert from a candidate with the expiry helper: 0 days is expiring, the day after is expired', () => {
    expect(alertOf('vehicle_document', candidate('d1', '2026-10-06'), TODAY, 30)).toEqual({
      key: 'vehicle_document:d1:2026-10-06',
      source: 'vehicle_document',
      subjectId: 'd1',
      vehicleId: 'veh-1',
      typeCode: 'registration_card',
      dueOn: '2026-10-06',
      daysToExpiry: 0,
      severity: 'expiring',
    });
    expect(alertOf('insurance_policy', candidate('p1', '2026-10-05'), TODAY, 30)).toMatchObject({
      daysToExpiry: -1,
      severity: 'expired',
    });
    expect(
      alertOf('insurance_policy', candidate('p1', '2026-11-05'), TODAY, 30)?.daysToExpiry,
    ).toBe(30);
    expect(alertOf('insurance_policy', candidate('p1', '2026-11-06'), TODAY, 30)).toBeNull();
    expect(alertOf('insurance_policy', candidate('p1', '2026-10-14'), TODAY, 7)).toBeNull();
    expect(expiryOf('2026-10-06', TODAY).status).toBe('expiring');
  });

  it('changes the key when the expiry date changes, so a renewal starts a new cycle', () => {
    const before = alertOf('vehicle_document', candidate('d1', '2026-10-10'), TODAY, 30);
    const after = alertOf('vehicle_document', candidate('d1', '2026-10-20'), TODAY, 30);
    expect(before?.key).not.toBe(after?.key);
  });
});

describe('AlertService.list', () => {
  const documents = {
    [A]: [
      candidate('d-late', '2026-10-20'),
      candidate('d-expired', '2026-09-01', 'veh-2'),
      candidate('d-today', '2026-10-06'),
      candidate('d-far', '2026-12-31'),
    ],
    'tenant-b': [candidate('d-b', '2026-10-07')],
  };
  const policies = {
    [A]: [
      candidate('p-soon', '2026-10-10', 'veh-2'),
      candidate('p-same-day', '2026-10-06', 'veh-9'),
    ],
  };

  it('merges both sources by due date, then source, then id, and counts the totals', async () => {
    const { service } = build(documents, policies);
    const slice = await service.list(A);
    expect(slice.asOf).toBe(TODAY);
    expect(slice.windowDays).toBe(30);
    expect(slice.total).toBe(5);
    expect(slice.items.map((alert) => [alert.source, alert.subjectId, alert.severity])).toEqual([
      ['vehicle_document', 'd-expired', 'expired'],
      ['insurance_policy', 'p-same-day', 'expiring'],
      ['vehicle_document', 'd-today', 'expiring'],
      ['insurance_policy', 'p-soon', 'expiring'],
      ['vehicle_document', 'd-late', 'expiring'],
    ]);
  });

  it('pages over the merged order', async () => {
    const { service } = build(documents, policies);
    const first = await service.list(A, { limit: 2 });
    const second = await service.list(A, { limit: 2, offset: 2 });
    const third = await service.list(A, { limit: 2, offset: 4 });
    expect([...first.items, ...second.items, ...third.items].map((a) => a.subjectId)).toEqual([
      'd-expired',
      'p-same-day',
      'd-today',
      'p-soon',
      'd-late',
    ]);
    expect(third.items).toHaveLength(1);
    expect((await service.list(A, { offset: 100 })).items).toEqual([]);
  });

  it('filters by source, severity and vehicle and never reads another tenant', async () => {
    const { service, docs, pols } = build(documents, policies);
    expect(
      (await service.list(A, { source: 'insurance_policy' })).items.map((a) => a.subjectId),
    ).toEqual(['p-same-day', 'p-soon']);
    expect(pols.calls).toHaveLength(1);
    expect(docs.calls).toHaveLength(0);
    expect((await service.list(A, { severity: 'expired' })).items.map((a) => a.subjectId)).toEqual([
      'd-expired',
    ]);
    expect(
      (await service.list(A, { severity: 'expiring', vehicleId: 'veh-2' })).items.map(
        (a) => a.subjectId,
      ),
    ).toEqual(['p-soon']);
    expect((await service.list('tenant-b')).items.map((a) => a.subjectId)).toEqual(['d-b']);
    expect((await service.list('tenant-c')).items).toEqual([]);
    expect(
      [...docs.calls, ...pols.calls].every((call) =>
        ['tenant-a', 'tenant-b', 'tenant-c'].includes(call.tenantId),
      ),
    ).toBe(true);
  });

  it('uses the company window: a narrower one hides what is further away', async () => {
    const { service, reads } = build(documents, policies, 7);
    expect((await service.list(A)).items.map((a) => a.subjectId)).toEqual([
      'd-expired',
      'p-same-day',
      'd-today',
      'p-soon',
    ]);
    expect(reads).toEqual([A]);
  });

  it('reads more than one page of a source when the offset needs it', async () => {
    const many = Array.from({ length: 250 }, (_, index) =>
      candidate(`d-${String(index).padStart(3, '0')}`, '2026-10-10'),
    );
    const { service, docs } = build({ [A]: many });
    const slice = await service.list(A, { limit: 25, offset: 120 });
    expect(slice.total).toBe(250);
    expect(slice.items[0]?.subjectId).toBe('d-120');
    expect(docs.calls.map((call) => call.offset)).toEqual([0, 100]);
    const last = await service.list(A, { limit: 100, offset: 200 });
    expect(last.items).toHaveLength(50);
  });

  it('drops candidates a source returns outside the window instead of alerting on them', async () => {
    const { service } = build({}, {});
    const stray = new AlertService(
      {
        vehicle_document: {
          due: async () => ({ items: [candidate('d-stray', '2027-06-01')], total: 1 }),
        },
        insurance_policy: { due: async () => ({ items: [], total: 0 }) },
      },
      { expiryWindowDays: async () => 30 },
      { now: () => NOW },
    );
    expect((await stray.list(A)).items).toEqual([]);
    expect(service).toBeInstanceOf(AlertService);
  });

  it('rejects malformed queries with invalid_input', async () => {
    const { service } = build(documents);
    const bad: Record<string, unknown>[] = [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: '25' },
      { offset: -1 },
      { offset: MAX_ALERT_OFFSET + 1 },
      { source: 'employee_document' },
      { severity: 'valid' },
      { vehicleId: 'bad id' },
      { vehicleId: 7 },
    ];
    for (const query of bad) expect(await code(() => service.list(A, query))).toBe('invalid_input');
    expect(await code(() => service.list('bad id'))).toBe('invalid_input');
    expect(await code(() => service.list(A, { offset: MAX_ALERT_OFFSET, limit: 100 }))).toBe(
      'resolved',
    );
  });

  it('uses the wall clock by default', async () => {
    const service = new AlertService(
      {
        vehicle_document: { due: async () => ({ items: [], total: 0 }) },
        insurance_policy: { due: async () => ({ items: [], total: 0 }) },
      },
      { expiryWindowDays: async () => 30 },
    );
    expect((await service.list(A)).asOf).toBe(new Date().toISOString().slice(0, 10));
    const kinds: AlertSourceKind[] = [...ALERT_SOURCES];
    expect(kinds).toHaveLength(2);
  });
});
