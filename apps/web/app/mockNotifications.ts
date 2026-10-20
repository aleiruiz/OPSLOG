import { createFakeNotifications } from '../features/notifications/fakePorts';
import type { NotificationsPorts } from '../features/notifications/ports';
import type { Guarded } from './mockApiTypes';

/** Notification center of the demo API: every signed-in person has one; the company rules need `manage_config`. */
export function createMockNotificationsPorts(guarded: Guarded): NotificationsPorts {
  const store = createFakeNotifications();
  return {
    list: (query) => guarded('notifications', null, () => store.list(query)),
    count: () => guarded('notifications', null, () => store.count()),
    markRead: (id) => guarded('notifications', null, () => store.markRead(id)),
    markAllRead: () => guarded('notifications', null, () => store.markAllRead()),
    preferences: () => guarded('notifications', null, () => store.preferences()),
    savePreferences: (input) => guarded('notifications', null, () => store.savePreferences(input)),
    subscriptions: (type) => guarded('notifications', null, () => store.subscriptions(type)),
    subscribe: (type, id) => guarded('notifications', null, () => store.subscribe(type, id)),
    unsubscribe: (type, id) => guarded('notifications', null, () => store.unsubscribe(type, id)),
    rule: () => guarded('notifications', 'manage_config', () => store.rule()),
    saveRule: (input) => guarded('notifications', 'manage_config', () => store.saveRule(input)),
    failedDeliveries: () =>
      guarded('notifications', 'manage_config', () => store.failedDeliveries()),
  };
}
