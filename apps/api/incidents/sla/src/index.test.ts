import { describe, expect, it, vi } from 'vitest';
import { IncidentError } from '../../../../../packages/domain/incidents/cases/src/index.js';
import { IncidentSlaApi } from './index.js';

const context = { tenantId: 'tenant-a', actor: { subject: 'sub-1' } };
function setup(page = { items: [], total: 0 }) {
  const alerts = vi.fn(async () => page);
  const deny = vi.fn(async () => undefined);
  const api = new IncidentSlaApi({
    authorize: async (token) => {
      if (token === 'bad') throw Object.assign(new Error('expired'), { code: 'expired' });
      return { context, permissions: ['incidents:view'] } as never;
    },
    mechanicLinked: async () => false,
    deny,
    reader: { alerts },
  });
  return { api, alerts, deny };
}

describe('incident SLA API', () => {
  it('reads the notices as the session member, never from the request', async () => {
    const { api, alerts } = setup({ items: [], total: 3 });
    const answer = await api.alerts('ok', 'corr-1', { limit: 25 });
    expect(answer).toEqual({ ok: true, value: { items: [], total: 3 } });
    expect(alerts).toHaveBeenCalledWith(
      'tenant-a',
      expect.objectContaining({ id: 'user-sub-1', mechanicLinked: false }),
      { limit: 25 },
    );
  });
  it('maps a bad session and a refusal to a safe error, and audits a refused access', async () => {
    const { api, alerts, deny } = setup();
    expect(await api.alerts('bad', 'corr-1', {})).toMatchObject({
      ok: false,
      error: { code: 'unauthorized', status: 401 },
    });
    alerts.mockRejectedValueOnce(new IncidentError('forbidden'));
    expect(await api.alerts('ok', 'corr-2', {})).toMatchObject({
      ok: false,
      error: { code: 'forbidden', status: 403 },
    });
    expect(deny).toHaveBeenCalledWith(context, 'incident.access_denied', 'alerts', 'corr-2');
    alerts.mockRejectedValueOnce(
      new IncidentError('invalid_input', [{ field: 'kind', code: 'invalid' }]),
    );
    expect(await api.alerts('ok', 'corr-3', { kind: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input', fieldErrors: [{ field: 'kind', code: 'invalid' }] },
    });
  });
});
