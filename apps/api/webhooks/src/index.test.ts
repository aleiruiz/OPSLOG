import { describe, expect, it } from 'vitest';
import { AuthError, type TenantContext } from '../../../../packages/domain/identity/src/index.js';
import { WebhookError } from '../../../../packages/domain/webhooks/src/index.js';
import { endpointOf, world } from '../../../../packages/domain/webhooks/src/test-support.js';
import { WebhooksApi, apiFailure, type WebhookAuditAction } from './index.js';

const ctx = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { subject: 'ana', kind: 'user' },
  authorizationVersion: 1,
  correlationId: 'c',
});

function rig() {
  const w = world();
  const audits: { action: WebhookAuditAction; id: string; tenantId: string }[] = [];
  const required: string[][] = [];
  const api = new WebhooksApi({
    service: w.service,
    authorize: async (token, _c, perms) => {
      required.push([...perms]);
      if (token === 'bad') throw new AuthError('forbidden');
      return ctx(token === 'b' ? 'tenant-b' : 'tenant-a');
    },
    audit: (context, action, id) => void audits.push({ action, id, tenantId: context.tenantId }),
  });
  return { w, api, audits, required };
}

describe('WebhooksApi', () => {
  it('requires integrations:manage on every call and audits changes by id only', async () => {
    const { api, audits, required, w } = rig();
    const created = await api.create('a', 'c1', {
      url: 'https://h.example.com/x',
      events: ['vehicle.created'],
    });
    expect(created.ok && created.value.secret).toMatch(/^whsec_/);
    const id = created.ok ? created.value.endpoint.id : '';
    const listed = await api.list('a', 'c');
    expect(listed.ok && listed.value).toMatchObject({ max: 5 });
    expect(listed.ok && listed.value.items).toHaveLength(1);
    expect((await api.get('a', 'c', id)).ok).toBe(true);
    expect((await api.update('a', 'c', id, { version: 1, active: false })).ok).toBe(true);
    expect((await api.update('a', 'c', id, { version: 2, active: true })).ok).toBe(true);
    const rotated = await api.rotate('a', 'c', id, 3);
    expect(rotated.ok && rotated.value.endpoint.version).toBe(4);
    expect((await api.test('a', 'c', id)).ok).toBe(true);
    const page = await api.deliveries('a', 'c', id, { limit: 10, offset: 0 });
    expect(page.ok && page.value).toMatchObject({ total: 1, limit: 10, offset: 0 });
    const delivery = page.ok ? page.value.items[0] : undefined;
    await w.store
      .settle(
        'tenant-a',
        delivery?.id as string,
        { kind: 'dead_letter', statusCode: 500, durationMs: 1, error: 'http_500' },
        w.clock.now().toISOString(),
        null,
      )
      .catch(() => undefined);
    expect((await api.retry('a', 'c', id, delivery?.id as string)).ok).toBe(true);
    expect((await api.remove('a', 'c', id)).ok).toBe(true);
    expect(required.every((r) => r.length === 1 && r[0] === 'integrations:manage')).toBe(true);
    expect(audits.map((a) => a.action)).toEqual([
      'webhook.endpoint_created',
      'webhook.endpoint_updated',
      'webhook.endpoint_updated',
      'webhook.secret_rotated',
      'webhook.test_sent',
      'webhook.delivery_retried',
      'webhook.endpoint_deleted',
    ]);
    // Nothing of the secret or the URL reaches the audit.
    const text = JSON.stringify(audits);
    expect(text).not.toContain('whsec_');
    expect(text).not.toContain('h.example.com');
  });

  it('answers 403 without the permission and never touches the service', async () => {
    const { api } = rig();
    for (const result of [
      await api.list('bad', 'c'),
      await api.create('bad', 'c', {} as never),
      await api.remove('bad', 'c', 'x'),
    ])
      expect(result).toMatchObject({ ok: false, error: { code: 'forbidden', status: 403 } });
  });

  it('keeps companies apart: B gets a 404 for the endpoint and the history of A', async () => {
    const { api, w } = rig();
    const { endpoint } = await endpointOf(w, 'tenant-a');
    for (const result of [
      await api.get('b', 'c', endpoint.id),
      await api.update('b', 'c', endpoint.id, { version: 1 }),
      await api.deliveries('b', 'c', endpoint.id, {}),
      await api.rotate('b', 'c', endpoint.id, 1),
      await api.test('b', 'c', endpoint.id),
    ])
      expect(result).toMatchObject({ ok: false, error: { code: 'not_found', status: 404 } });
  });

  it('defaults and bounds the window', async () => {
    const { api, w } = rig();
    const { endpoint } = await endpointOf(w, 'tenant-a');
    const page = await api.deliveries('a', 'c', endpoint.id, { limit: 5000, offset: -3 });
    expect(page.ok && page.value).toMatchObject({ limit: 100, offset: 0 });
    const zero = await api.deliveries('a', 'c', endpoint.id, { limit: 0 });
    expect(zero.ok && zero.value.limit).toBe(25);
  });

  it('maps failures to fixed codes without echoing input', () => {
    expect(apiFailure(new WebhookError('invalid_input', 'url'))).toEqual({
      ok: false,
      error: {
        code: 'invalid_input',
        status: 400,
        message: 'Webhooks request rejected: invalid_input',
        fieldErrors: [{ field: 'url', code: 'invalid' }],
      },
    });
    expect(apiFailure(new WebhookError('limit_reached'))).toMatchObject({
      error: { code: 'rule_violation', status: 422, rule: 'limit_reached' },
    });
    expect(apiFailure(new WebhookError('stale_version'))).toMatchObject({ error: { status: 409 } });
    expect(apiFailure(new WebhookError('invalid_transition'))).toMatchObject({
      error: { status: 409 },
    });
    expect(apiFailure(new AuthError('expired'))).toMatchObject({ error: { code: 'unauthorized' } });
    expect(apiFailure(new AuthError('unauthorized'))).toMatchObject({
      error: { code: 'unauthorized' },
    });
    expect(apiFailure(new AuthError('invalid_input'))).toMatchObject({
      error: { code: 'invalid_input' },
    });
    expect(apiFailure(new AuthError('bogus' as never))).toMatchObject({
      error: { code: 'internal_error' },
    });
    expect(apiFailure(new Error('SELECT secret FROM x'))).toEqual({
      ok: false,
      error: { code: 'internal_error', status: 500, message: 'Request failed' },
    });
  });
});
