import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../../../../packages/domain/identity/src/index.js';
import {
  MANAGER,
  TENANT_A,
  TENANT_B,
  caseIn,
  setup,
} from '../../../../../packages/domain/incidents/costs/src/test-support.js';
import { IncidentCostApi } from './index.js';

function world() {
  const base = setup();
  const sessions = new Map<string, { tenantId: string; permissions: readonly string[] }>();
  const denials: string[] = [];
  const api = new IncidentCostApi({
    costs: base.costService,
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
    deny: async (_context, action) => {
      denials.push(action);
    },
  });
  const edit = ['incidents:view', 'incidents:edit'];
  sessions.set('costs', { tenantId: TENANT_A, permissions: [...edit, 'incidents:view_costs'] });
  sessions.set('plain', { tenantId: TENANT_A, permissions: edit });
  sessions.set('other', { tenantId: TENANT_B, permissions: [...edit, 'incidents:view_costs'] });
  return { ...base, api, denials };
}
const line = {
  kind: 'expense',
  category: 'towing',
  amount: { amountMinor: '500', currency: 'MXN' },
};

describe('IncidentCostApi', () => {
  it('reads and replaces the costs of the session tenant, with the key', async () => {
    const w = world();
    const incident = await caseIn(w, 'under_review');
    const saved = await w.api.update(
      'costs',
      'c1',
      incident.id,
      { version: incident.version, lines: [line] },
      'key-api-costs-001',
    );
    expect(saved).toMatchObject({
      ok: true,
      value: { totals: [{ currency: 'MXN', companyBorne: '500' }], version: incident.version + 1 },
    });
    const read = await w.api.get('costs', 'c2', incident.id);
    expect(read.value?.lines).toHaveLength(1);
  });

  it('answers 403 without a single amount when view_costs is missing, and audits the refusal', async () => {
    const w = world();
    const incident = await caseIn(w, 'under_review');
    await w.api.update(
      'costs',
      'c1',
      incident.id,
      { version: incident.version, lines: [line] },
      'key-api-costs-002',
    );
    const hidden = await w.api.get('plain', 'c2', incident.id);
    expect(hidden).toMatchObject({ ok: false, error: { code: 'forbidden', status: 403 } });
    expect(JSON.stringify(hidden)).not.toMatch(/500|MXN|totals/);
    const write = await w.api.update(
      'plain',
      'c3',
      incident.id,
      { version: incident.version + 1, lines: [] },
      'key-api-costs-003',
    );
    expect(write).toMatchObject({ ok: false, error: { status: 403 } });
    expect(w.denials).toEqual(['incident.access_denied', 'incident.access_denied']);
  });

  it('answers safe errors: 401, 404 across tenants, 400 without key, 409 stale, 400 bad body', async () => {
    const w = world();
    const incident = await caseIn(w, 'under_review');
    expect(await w.api.get('nobody', 'c1', incident.id)).toMatchObject({ error: { status: 401 } });
    expect(await w.api.get('other', 'c2', incident.id)).toMatchObject({
      error: { code: 'not_found', status: 404 },
    });
    expect(
      await w.api.update('costs', 'c3', incident.id, { version: incident.version, lines: [] }),
    ).toMatchObject({
      error: { code: 'idempotency_key_required', status: 400 },
    });
    expect(
      await w.api.update(
        'costs',
        'c4',
        incident.id,
        { version: 99, lines: [] },
        'key-api-costs-004',
      ),
    ).toMatchObject({
      error: { code: 'stale_version', status: 409 },
    });
    const bad = await w.api.update(
      'costs',
      'c5',
      incident.id,
      {
        version: incident.version,
        lines: [{ ...line, amount: { amountMinor: '-5', currency: 'MXN' } }],
      },
      'key-api-costs-005',
    );
    expect(bad).toMatchObject({ error: { code: 'invalid_input', status: 400 } });
    expect(JSON.stringify(bad)).not.toContain('-5');
  });
});
