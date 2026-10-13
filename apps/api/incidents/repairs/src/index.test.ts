import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../../../../packages/domain/identity/src/index.js';
import {
  MANAGER,
  TENANT_A,
  TENANT_B,
  caseIn,
  setup,
} from '../../../../../packages/domain/incidents/repairs/src/test-support.js';
import { IncidentRepairApi } from './index.js';

function world() {
  const base = setup();
  const sessions = new Map<string, { tenantId: string; permissions: readonly string[] }>();
  const denials: string[] = [];
  const api = new IncidentRepairApi({
    repairs: base.service,
    authorize: async (token, correlationId) => {
      const session = sessions.get(token);
      if (!session) throw Object.assign(new Error('x'), { code: 'unauthorized' });
      const context: TenantContext = {
        tenantId: session.tenantId,
        actor: { subject: MANAGER.subject, kind: 'user' },
        authorizationVersion: 1,
        correlationId,
      };
      return { context, permissions: session.permissions as never };
    },
    mechanicLinked: async () => false,
    labels: { member: async () => 'Responsable' },
    deny: async (_context, action) => {
      denials.push(action);
    },
  });
  sessions.set('editor', { tenantId: TENANT_A, permissions: ['incidents:view', 'incidents:edit'] });
  sessions.set('viewer', { tenantId: TENANT_A, permissions: ['incidents:view'] });
  sessions.set('other', { tenantId: TENANT_B, permissions: ['incidents:view', 'incidents:edit'] });
  return { ...base, api, denials };
}

describe('IncidentRepairApi', () => {
  it('links, lists and unlinks; people are shown by name and no amount ever appears', async () => {
    const w = world();
    w.orders.add('o1', { costs: [{ amountMinor: '123456', currency: 'MXN' }] });
    const incident = await caseIn(w, 'under_review');
    const linked = await w.api.link(
      'editor',
      'c1',
      incident.id,
      { version: incident.version, orderId: 'o1' },
      'key-api-links-001',
    );
    expect(linked).toMatchObject({
      ok: true,
      value: {
        version: incident.version + 1,
        item: { orderId: 'o1', linkedBy: { displayName: 'Responsable' } },
      },
    });
    expect(JSON.stringify(linked)).not.toMatch(/123456|MXN|user-/);
    const list = await w.api.list('viewer', 'c2', incident.id);
    expect(list.value?.items).toHaveLength(1);
    const id = linked.value?.item.id ?? '';
    const gone = await w.api.unlink(
      'editor',
      'c3',
      incident.id,
      id,
      { version: incident.version + 1 },
      'key-api-links-002',
    );
    expect(gone).toMatchObject({ ok: true, value: { version: incident.version + 2 } });
  });

  it('answers safe errors: 403 for a viewer, 404 across tenants, 401 without session, 400 without key, 409 duplicate', async () => {
    const w = world();
    w.orders.add('o1');
    const incident = await caseIn(w, 'under_review');
    const body = { version: incident.version, orderId: 'o1' };
    expect(await w.api.link('viewer', 'c1', incident.id, body, 'key-api-links-003')).toMatchObject({
      error: { code: 'forbidden', status: 403 },
    });
    expect(await w.api.list('other', 'c2', incident.id)).toMatchObject({
      error: { code: 'not_found', status: 404 },
    });
    expect(await w.api.list('nobody', 'c3', incident.id)).toMatchObject({ error: { status: 401 } });
    expect(await w.api.link('editor', 'c4', incident.id, body)).toMatchObject({
      error: { code: 'idempotency_key_required', status: 400 },
    });
    const first = await w.api.link('editor', 'c5', incident.id, body, 'key-api-links-004');
    expect(first.ok).toBe(true);
    const other = await caseIn(w, 'under_review');
    expect(
      await w.api.link(
        'editor',
        'c6',
        other.id,
        { version: other.version, orderId: 'o1' },
        'key-api-links-005',
      ),
    ).toMatchObject({
      error: { code: 'duplicate', status: 409 },
    });
    expect(w.denials).toContain('incident.access_denied');
  });
});
