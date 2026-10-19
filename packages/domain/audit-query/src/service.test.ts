import { describe, expect, it } from 'vitest';
import { AuditQueryError } from './errors.js';
import { InMemoryAuditReader, InMemoryAuditReconciler } from './memory.js';
import { AuditQueryService } from './service.js';
import type { AuditEventRow, ChangeSource, EntityDescriber } from './types.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const USER_A = 'user-aaaaaaaa-0000-0000-0000-000000000001';

function row(over: Partial<AuditEventRow> & { eventId: string }): AuditEventRow {
  return {
    action: 'vehicle.updated',
    entityType: 'vehicle',
    entityId: 'veh-1',
    occurredAt: '2026-10-18T10:00:00.000Z',
    actor: { id: USER_A, kind: 'user' },
    correlationId: 'corr-1',
    ...over,
  };
}

const store: Record<string, AuditEventRow[]> = {
  A: [
    row({ eventId: 'a1' }),
    row({
      eventId: 'a2',
      occurredAt: '2026-10-18T11:00:00.000Z',
      action: 'incident.updated',
      entityType: 'incident',
      entityId: 'inc-1',
    }),
    row({
      eventId: 'a3',
      occurredAt: '2026-10-18T11:00:00.000Z',
      action: 'incident.access_denied',
      entityType: 'incident',
      entityId: 'inc-1',
      actor: { id: 'system', kind: 'system' },
    }),
    row({
      eventId: 'a4',
      occurredAt: '2026-10-17T11:00:00.000Z',
      entityType: 'employee',
      entityId: 'emp-1',
    }),
    row({
      eventId: 'a5',
      occurredAt: '2026-10-16T11:00:00.000Z',
      entityType: 'area',
      entityId: 'gone',
    }),
    row({ eventId: 'a6', occurredAt: '2026-09-01T11:00:00.000Z' }),
  ],
  B: [
    row({ eventId: 'b1', entityId: 'veh-1' }),
    row({ eventId: 'b2', entityType: 'incident', entityId: 'inc-9' }),
  ],
};

const describers: Record<string, EntityDescriber> = {
  vehicle: { describe: async (_t, id) => (id === 'veh-1' ? { label: 'ECO-001' } : null) },
  employee: { describe: async () => ({ label: 'Empleado 17', pii: true }) },
  area: { describe: async () => null },
};
const incidentChanges: ChangeSource = {
  changes: async (tenantId, id) =>
    tenantId === 'A' && id === 'inc-1'
      ? [
          {
            occurredAt: '2026-10-18T11:00:00.000Z',
            command: 'update',
            fields: [{ name: 'severity', before: 'low', after: 'high' }, { name: 'description' }],
          },
        ]
      : [],
};

function service(roleOf: (t: string, a: string) => Promise<string | null> = async () => 'Auditor') {
  const snapshot = (tenantId: string) => store[tenantId] ?? [];
  return new AuditQueryService({
    reader: new InMemoryAuditReader(snapshot),
    reconciler: new InMemoryAuditReconciler(snapshot),
    describers,
    changeSources: { incident: incidentChanges },
    roleOf,
    now: () => NOW,
  });
}
const auditor = { permissions: ['view', 'view_audit'] };

describe('AuditQueryService.list', () => {
  it('lists the last 30 days of the company, newest first, with readable text', async () => {
    const page = await service().list('A', auditor, {});
    expect(page.items.map((item) => item.eventId)).toEqual(['a3', 'a2', 'a1', 'a4', 'a5']);
    expect(page.total).toBe(5);
    expect(page.next).toBeNull();
    const first = page.items.find((item) => item.eventId === 'a1');
    expect(first).toMatchObject({
      actionLabel: 'Vehículo actualizado',
      result: 'success',
      entityTypeLabel: 'Vehículo',
      entityLabel: 'ECO-001',
      entityAvailable: true,
      actor: { kind: 'user', label: 'Auditor' },
    });
    expect(first?.actor.alias).toMatch(/^U-/);
  });

  it('marks denied attempts, system actors and records that are gone', async () => {
    const page = await service().list('A', auditor, {});
    const denied = page.items.find((item) => item.eventId === 'a3');
    expect(denied).toMatchObject({ result: 'denied', actor: { label: 'Sistema' } });
    const gone = page.items.find((item) => item.eventId === 'a5');
    expect(gone).toMatchObject({ entityLabel: 'Registro no disponible', entityAvailable: false });
    expect((await service().list('A', auditor, { result: 'denied' })).items).toHaveLength(1);
  });

  it('hides the description of a person without view_pii and falls back to type and short id', async () => {
    const plain = await service().list('A', auditor, { entityType: 'employee' });
    expect(plain.items[0]?.entityLabel).toBe('Persona de la plantilla');
    const allowed = await service().list(
      'A',
      { permissions: ['view_audit', 'view_pii'] },
      { entityType: 'employee' },
    );
    expect(allowed.items[0]?.entityLabel).toBe('Empleado 17');
    const undescribed = await service().list('A', auditor, { entityType: 'incident' });
    expect(undescribed.items[0]?.entityLabel).toBe('Siniestro inc-1');
  });

  it('shows the diff only to readers of the module and never sends restricted values', async () => {
    const withModule = await service().list(
      'A',
      { permissions: ['view_audit', 'incidents:view'] },
      { action: 'incident.updated' },
    );
    expect(withModule.items[0]?.changes).toEqual([
      { field: 'severity', label: 'Gravedad', state: 'value', before: 'low', after: 'high' },
      { field: 'description', label: 'Descripción', state: 'restricted' },
    ]);
    const without = await service().list('A', auditor, { action: 'incident.updated' });
    expect(without.items[0]?.changes).toBeNull();
  });

  it('pages by keyset without repeating or skipping rows', async () => {
    const svc = service();
    const seen: string[] = [];
    // Page size 25 is the smallest, so shrink the data by range instead.
    const wide = { from: '2026-01-01T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z' };
    const everything = await svc.list('A', auditor, wide);
    expect(everything.items).toHaveLength(6);
    const many: Record<string, AuditEventRow[]> = { A: [] };
    for (let i = 0; i < 60; i += 1)
      many['A']?.push(
        row({
          eventId: `e${String(i).padStart(3, '0')}`,
          occurredAt: `2026-10-18T10:00:${String(i % 3).padStart(2, '0')}.000Z`,
        }),
      );
    const snap = (t: string) => many[t] ?? [];
    const paged = new AuditQueryService({
      reader: new InMemoryAuditReader(snap),
      reconciler: new InMemoryAuditReconciler(snap),
      roleOf: async () => null,
      now: () => NOW,
    });
    let after: { occurredAt: string; eventId: string } | undefined;
    for (let guard = 0; guard < 5; guard += 1) {
      const page = await paged.list('A', auditor, { limit: 25, ...(after ? { after } : {}) });
      seen.push(...page.items.map((item) => item.eventId));
      if (!page.next) break;
      after = page.next;
    }
    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
  });

  it('never returns rows of another company, even when asked for their ids', async () => {
    const page = await service().list('A', auditor, { entityType: 'incident', entityId: 'inc-9' });
    expect(page.items).toEqual([]);
    expect((await service().list('B', auditor, { entityId: 'inc-9' })).items).toHaveLength(1);
  });
});

describe('AuditQueryService.forEntity and reconciliation', () => {
  it('needs the permission of the record module on top of the audit', async () => {
    const svc = service();
    await expect(svc.forEntity('A', auditor, 'incident', 'inc-1', {})).rejects.toMatchObject({
      code: 'forbidden',
    });
    const page = await svc.forEntity(
      'A',
      { permissions: ['view_audit', 'incidents:view'] },
      'incident',
      'inc-1',
      {},
    );
    expect(page.items.map((item) => item.eventId)).toEqual(['a3', 'a2']);
    expect((await svc.forEntity('A', auditor, 'vehicle', 'veh-1', {})).items).toHaveLength(1);
    await expect(svc.forEntity('A', auditor, 'nonsense', 'x', {})).rejects.toBeInstanceOf(
      AuditQueryError,
    );
  });

  it('reconciles an in-memory audit as fully relayed', async () => {
    const report = await service().reconciliation('A', {});
    expect(report).toMatchObject({
      local: 5,
      relayed: 5,
      pendingTotal: 0,
      pending: [],
      oldestPendingAgeSeconds: null,
    });
    await expect(
      service().reconciliation('A', { from: '2026-01-01T00:00:00.000Z' }),
    ).rejects.toBeInstanceOf(AuditQueryError);
  });

  it('labels users without a known role', async () => {
    const page = await service(async () => null).list('A', auditor, { entityId: 'veh-1' });
    expect(page.items[0]?.actor.label).toBe('Usuario de la empresa');
  });
});

describe('AuditQueryService clock', () => {
  it('uses the system clock when none is injected', async () => {
    const snapshot = (tenantId: string) => store[tenantId] ?? [];
    const bare = new AuditQueryService({
      reader: new InMemoryAuditReader(snapshot),
      reconciler: new InMemoryAuditReconciler(snapshot),
      describers,
      roleOf: async () => null,
    });
    const page = await bare.list('A', auditor, {});
    expect(Date.parse(page.to) - Date.parse(page.from)).toBe(30 * 86_400_000);
  });
});
