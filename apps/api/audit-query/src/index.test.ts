import { describe, expect, it } from 'vitest';
import {
  AuditQueryError,
  AuditQueryService,
  InMemoryAuditReader,
  InMemoryAuditReconciler,
  type AuditEventRow,
} from '../../../../packages/domain/audit-query/src/index.js';
import { AuthError } from '../../../../packages/domain/identity/src/index.js';
import { AuditQueryApi } from './index.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const rows: AuditEventRow[] = [
  {
    eventId: 'e1',
    action: 'vehicle.created',
    entityType: 'vehicle',
    entityId: 'veh-1',
    occurredAt: '2026-10-18T10:00:00.000Z',
    actor: { id: 'user-1', kind: 'user' },
    correlationId: 'c1',
  },
];

function api(authorize: ConstructorParameters<typeof AuditQueryApi>[0]['authorize']) {
  const snapshot = (tenantId: string) => (tenantId === 'tenant-a' ? rows : []);
  return new AuditQueryApi({
    authorize,
    service: new AuditQueryService({
      reader: new InMemoryAuditReader(snapshot),
      reconciler: new InMemoryAuditReconciler(snapshot),
      roleOf: async () => 'Auditor',
      now: () => NOW,
    }),
  });
}
const allowed =
  (tenantId: string, permissions: string[] = ['view_audit']) =>
  async () => ({ context: { tenantId } as never, permissions: permissions as never });

describe('AuditQueryApi', () => {
  it('answers with the page of the session company and its id for cursors', async () => {
    const result = await api(allowed('tenant-a')).list('tok', 'corr', {});
    expect(result.ok).toBe(true);
    expect(result.value?.tenantId).toBe('tenant-a');
    expect(result.value?.items.map((item) => item.eventId)).toEqual(['e1']);
    expect((await api(allowed('tenant-b')).list('tok', 'corr', {})).value?.items).toEqual([]);
  });

  it('answers per entity and reconciles', async () => {
    const subject = api(allowed('tenant-a', ['view_audit', 'view']));
    const entity = await subject.forEntity('tok', 'corr', 'vehicle', 'veh-1', {});
    expect(entity.value?.items).toHaveLength(1);
    const report = await subject.reconciliation('tok', 'corr', {});
    expect(report.value).toMatchObject({ local: 1, pendingTotal: 0 });
  });

  it('maps rejections to safe errors without echoing anything', async () => {
    const bad = await api(allowed('tenant-a')).list('tok', 'corr', { limit: 7 });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_input', status: 400 } });
    const forbidden = await api(allowed('tenant-a')).forEntity('tok', 'corr', 'incident', 'i', {});
    expect(forbidden.error).toMatchObject({ code: 'forbidden', status: 403 });
    const unknownType = await api(allowed('tenant-a')).forEntity('tok', 'corr', 'zzz', 'i', {});
    expect(unknownType.error?.code).toBe('invalid_input');
    for (const [code, expected, status] of [
      ['unauthorized', 'unauthorized', 401],
      ['expired', 'unauthorized', 401],
      ['forbidden', 'forbidden', 403],
      ['invalid_input', 'invalid_input', 400],
      ['not_found', 'not_found', 404],
      ['conflict', 'internal_error', 500],
    ] as const) {
      const result = await api(async () => {
        throw new AuthError(code);
      }).list('tok', 'corr', {});
      expect(result.error).toMatchObject({ code: expected, status });
    }
    const crash = await api(async () => {
      throw new Error('mysql://root:secret@host'); // secret-scan:allow fake URL proving the error is redacted
    }).reconciliation('tok', 'corr', {});
    expect(crash.error).toEqual({ code: 'internal_error', status: 500, message: 'Request failed' });
    expect(new AuditQueryError('not_found').code).toBe('not_found');
  });
});
