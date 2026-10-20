import { describe, expect, it, vi } from 'vitest';
import type { Guarded } from './mockApiTypes';
import { createMockNotificationsPorts } from './mockNotifications';

describe('mock notifications ports', () => {
  it('guards the personal center with no permission and the company rules with manage_config', async () => {
    const guarded = vi.fn(async (_operation, _permission, action) =>
      action(),
    ) as unknown as Guarded & ReturnType<typeof vi.fn>;
    const ports = createMockNotificationsPorts(guarded);
    const permissions = async (run: () => Promise<unknown>) => {
      guarded.mockClear();
      await run();
      return [guarded.mock.calls[0]?.[0], guarded.mock.calls[0]?.[1]];
    };
    const open = [
      () => ports.list({}),
      () => ports.count(),
      () => ports.markRead('ntf-1'),
      () => ports.markAllRead(),
      () => ports.preferences(),
      () => ports.savePreferences({ items: [] }),
      () => ports.subscriptions(),
      () => ports.subscribe('incident', 'inc-1'),
      () => ports.unsubscribe('incident', 'inc-1'),
    ];
    for (const run of open) expect(await permissions(run)).toEqual(['notifications', null]);
    const managed = [
      () => ports.rule(),
      () => ports.saveRule({ emailKinds: [], quietHours: false }),
      () => ports.failedDeliveries(),
    ];
    for (const run of managed)
      expect(await permissions(run)).toEqual(['notifications', 'manage_config']);
  });
});
