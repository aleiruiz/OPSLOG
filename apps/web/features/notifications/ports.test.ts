import { describe, expect, it, vi } from 'vitest';
import { createNotificationsPorts } from './ports';

const setup = () => {
  const call = vi.fn(async () => ({ ok: true as const, value: {} }));
  return { call, ports: createNotificationsPorts({ call } as never) };
};

describe('notifications ports', () => {
  it('lists with and without a query', async () => {
    const { call, ports } = setup();
    await ports.list();
    expect(call).toHaveBeenLastCalledWith('notifications.list', undefined);
    await ports.list({ unread: 'true' });
    expect(call).toHaveBeenLastCalledWith('notifications.list', { query: { unread: 'true' } });
  });

  it('counts, reads one and reads all', async () => {
    const { call, ports } = setup();
    await ports.count();
    expect(call).toHaveBeenLastCalledWith('notifications.count');
    await ports.markRead('n-1');
    expect(call).toHaveBeenLastCalledWith('notifications.read', {
      params: { notificationId: 'n-1' },
    });
    await ports.markAllRead();
    expect(call).toHaveBeenLastCalledWith('notifications.readAll');
  });

  it('reads and saves preferences', async () => {
    const { call, ports } = setup();
    await ports.preferences();
    expect(call).toHaveBeenLastCalledWith('notifications.preferences.get');
    const body = { items: [{ eventKind: 'incident_sla', inApp: true, email: false }] } as const;
    await ports.savePreferences(body);
    expect(call).toHaveBeenLastCalledWith('notifications.preferences.update', { body });
  });

  it('lists, creates and removes subscriptions', async () => {
    const { call, ports } = setup();
    await ports.subscriptions();
    expect(call).toHaveBeenLastCalledWith('notifications.subscriptions.list', undefined);
    await ports.subscriptions('incident');
    expect(call).toHaveBeenLastCalledWith('notifications.subscriptions.list', {
      query: { type: 'incident' },
    });
    await ports.subscribe('incident', 'inc-1');
    expect(call).toHaveBeenLastCalledWith('notifications.subscribe', {
      params: { type: 'incident', entityId: 'inc-1' },
    });
    await ports.unsubscribe('incident', 'inc-1');
    expect(call).toHaveBeenLastCalledWith('notifications.unsubscribe', {
      params: { type: 'incident', entityId: 'inc-1' },
    });
  });

  it('reads and saves the company rule and lists failed deliveries', async () => {
    const { call, ports } = setup();
    await ports.rule();
    expect(call).toHaveBeenLastCalledWith('notifications.rules.get');
    const body = { emailKinds: ['export_ready'], quietHours: true } as const;
    await ports.saveRule({ emailKinds: [...body.emailKinds], quietHours: true });
    expect(call).toHaveBeenLastCalledWith('notifications.rules.update', {
      body: { emailKinds: ['export_ready'], quietHours: true },
    });
    await ports.failedDeliveries();
    expect(call).toHaveBeenLastCalledWith('notifications.deliveries.failed');
  });
});
