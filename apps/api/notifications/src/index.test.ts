import { describe, expect, it } from 'vitest';
import { AuthError } from '../../../../packages/domain/identity/src/index.js';
import { harness } from '../../../../packages/domain/notifications/src/test-support.js';
import { NotificationsApi } from './index.js';

function setup() {
  const h = harness();
  const members: Record<string, { tenantId: string; subject: string }> = {
    ana: { tenantId: 'A', subject: 'ana' },
    root: { tenantId: 'A', subject: 'root' },
    vera: { tenantId: 'A', subject: 'vera' },
    anaB: { tenantId: 'B', subject: 'ana' },
  };
  const api = new NotificationsApi({
    service: h.service,
    authorize: async (token) => {
      if (token === 'expired') throw new AuthError('expired');
      if (token === 'denied') throw new AuthError('forbidden');
      if (token === 'broken') throw new Error('database password is hunter2');
      const who = members[token];
      if (!who) throw new AuthError('unauthorized');
      const access = h.actor(who.tenantId, who.subject).access;
      return { ...who, permissions: access.permissions, mechanicLinked: access.mechanicLinked };
    },
  });
  return { h, api };
}

describe('NotificationsApi', () => {
  it('lists the notices of the session person without company or recipient, with the counter', async () => {
    const { h, api } = setup();
    await h.ingest.ingest(h.event());
    const listed = await api.list('ana', 'c', { limit: 5 });
    if (!listed.ok) throw new Error('expected ok');
    expect(listed.value).toMatchObject({ total: 1, unread: 1 });
    expect(Object.keys(listed.value.items[0]!).sort()).toEqual([
      'createdAt',
      'entityId',
      'entityType',
      'eventKind',
      'id',
      'link',
      'readAt',
      'severity',
      'title',
    ]);
    expect(await api.count('ana', 'c')).toEqual({ ok: true, value: { unread: 1 } });
    // The same person in the other company, and someone else in this one, see nothing.
    expect(await api.count('anaB', 'c')).toEqual({ ok: true, value: { unread: 0 } });
    expect(await api.count('root', 'c')).toEqual({ ok: true, value: { unread: 0 } });
  });

  it('marks one notice and then all as read; another person gets not found', async () => {
    const { h, api } = setup();
    await h.ingest.ingest(h.event());
    await h.ingest.ingest(h.event({ entityId: 'doc-2' }));
    const listed = await api.list('ana', 'c');
    if (!listed.ok) throw new Error('expected ok');
    const [first] = listed.value.items;
    expect(await api.markRead('root', 'c', first!.id)).toMatchObject({ error: { status: 404 } });
    expect(await api.markRead('anaB', 'c', first!.id)).toMatchObject({ error: { status: 404 } });
    const read = await api.markRead('ana', 'c', first!.id);
    expect(read.ok && read.value.readAt).not.toBeNull();
    expect(await api.markAllRead('ana', 'c')).toEqual({ ok: true, value: { changed: 1 } });
    expect(await api.count('ana', 'c')).toEqual({ ok: true, value: { unread: 0 } });
  });

  it('reads and saves preferences, and answers 422 when a mandatory notice is switched off', async () => {
    const { api } = setup();
    const before = await api.preferences('vera', 'c');
    expect(before.ok && before.value.items.length).toBeGreaterThan(0);
    const saved = await api.savePreferences('vera', 'c', [
      { eventKind: 'document_expiring', inApp: true, email: false },
    ]);
    expect(
      saved.ok && saved.value.items.find((i) => i.eventKind === 'document_expiring')?.email,
    ).toBe(false);
    expect(
      await api.savePreferences('vera', 'c', [
        { eventKind: 'export_ready', inApp: false, email: true },
      ]),
    ).toMatchObject({ error: { status: 422, code: 'rule_violation', rule: 'mandatory' } });
    expect(await api.savePreferences('vera', 'c', 'x')).toMatchObject({
      error: { status: 400, field: 'preferences' },
    });
  });

  it('follows, lists and unfollows what the person sees', async () => {
    const { api } = setup();
    expect(await api.subscribe('ana', 'c', 'vehicle', 'v1')).toMatchObject({
      ok: true,
      value: { entityType: 'vehicle', entityId: 'v1' },
    });
    const listed = await api.subscriptions('ana', 'c');
    expect(listed.ok && listed.value.items.map((i) => i.entityId)).toEqual(['v1']);
    expect(Object.keys((listed.ok && listed.value.items[0]) || {}).sort()).toEqual([
      'createdAt',
      'entityId',
      'entityType',
    ]);
    expect((await api.subscriptions('ana', 'c', 'incident')).ok).toBe(true);
    expect(await api.subscriptions('ana', 'c', 'export')).toMatchObject({
      error: { status: 400, field: 'type' },
    });
    expect(await api.subscriptions('anaB', 'c')).toEqual({ ok: true, value: { items: [] } });
    expect(await api.unsubscribe('ana', 'c', 'vehicle', 'v1')).toEqual({
      ok: true,
      value: { removed: true },
    });
    expect(await api.subscribe('vera', 'c', 'incident', 'i1')).toMatchObject({
      error: { status: 404 },
    });
    expect(await api.subscribe('ana', 'c', 'nope', 'v1')).toMatchObject({ error: { status: 400 } });
  });

  it('keeps the company rule and the failed deliveries for the administrator', async () => {
    const { api } = setup();
    expect(await api.rule('ana', 'c')).toMatchObject({ error: { status: 403 } });
    expect(await api.failedDeliveries('ana', 'c')).toMatchObject({ error: { status: 403 } });
    expect(await api.saveRule('ana', 'c', { emailKinds: [], quietHours: false })).toMatchObject({
      error: { status: 403 },
    });
    const saved = await api.saveRule('root', 'c', {
      emailKinds: ['export_ready'],
      quietHours: true,
    });
    expect(saved).toMatchObject({
      ok: true,
      value: { quietHours: true, emailKinds: ['export_ready'] },
    });
    expect(await api.rule('root', 'c')).toEqual(saved);
    expect(await api.saveRule('root', 'c', { emailKinds: 'x', quietHours: true })).toMatchObject({
      error: { status: 400 },
    });
    expect(await api.failedDeliveries('root', 'c')).toEqual({
      ok: true,
      value: { items: [], total: 0 },
    });
    expect(await api.failedDeliveries('root', 'c', { limit: 0 })).toMatchObject({
      error: { status: 400 },
    });
  });

  it('maps session failures and hides the text of unexpected ones', async () => {
    const { api } = setup();
    expect(await api.count('nobody', 'c')).toMatchObject({ error: { status: 401 } });
    expect(await api.count('expired', 'c')).toMatchObject({ error: { status: 401 } });
    expect(await api.count('denied', 'c')).toMatchObject({ error: { status: 403 } });
    const broken = await api.count('broken', 'c');
    expect(broken).toMatchObject({
      error: { status: 500, code: 'internal_error', message: 'Request failed' },
    });
    expect(JSON.stringify(broken)).not.toContain('hunter2');
    const odd = new NotificationsApi({
      service: setup().h.service,
      authorize: async () => {
        throw new AuthError('rate_limited' as never);
      },
    });
    expect(await odd.count('x', 'c')).toMatchObject({ error: { status: 500 } });
    const bad = new NotificationsApi({
      service: setup().h.service,
      authorize: async () => {
        throw new AuthError('invalid_input');
      },
    });
    expect(await bad.count('x', 'c')).toMatchObject({ error: { status: 400 } });
  });
});
