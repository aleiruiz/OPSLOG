import type {
  BffClient,
  BffFailedDeliveryList,
  BffNotification,
  BffNotificationList,
  BffNotificationPreferenceInput,
  BffNotificationPreferences,
  BffNotificationRule,
  BffNotificationRuleInput,
  BffNotificationsQuery,
  BffReadAllResult,
  BffSubscription,
  BffSubscriptionList,
  BffSubscriptionType,
  BffUnreadCount,
} from '@opslog/contracts';
import type { Result } from '../../app/types';

/** What the notification center needs from the BFF. Who sees what is decided on the server. */
export interface NotificationsPorts {
  list(query?: BffNotificationsQuery): Promise<Result<BffNotificationList>>;
  count(): Promise<Result<BffUnreadCount>>;
  markRead(notificationId: string): Promise<Result<BffNotification>>;
  markAllRead(): Promise<Result<BffReadAllResult>>;
  preferences(): Promise<Result<BffNotificationPreferences>>;
  savePreferences(
    input: BffNotificationPreferenceInput,
  ): Promise<Result<BffNotificationPreferences>>;
  subscriptions(type?: BffSubscriptionType): Promise<Result<BffSubscriptionList>>;
  subscribe(type: BffSubscriptionType, entityId: string): Promise<Result<BffSubscription>>;
  unsubscribe(type: BffSubscriptionType, entityId: string): Promise<Result<void>>;
  rule(): Promise<Result<BffNotificationRule>>;
  saveRule(input: BffNotificationRuleInput): Promise<Result<BffNotificationRule>>;
  failedDeliveries(): Promise<Result<BffFailedDeliveryList>>;
}

export function createNotificationsPorts(client: BffClient): NotificationsPorts {
  return {
    list: (query) => client.call('notifications.list', query ? { query } : undefined),
    count: () => client.call('notifications.count'),
    markRead: (notificationId) => client.call('notifications.read', { params: { notificationId } }),
    markAllRead: () => client.call('notifications.readAll'),
    preferences: () => client.call('notifications.preferences.get'),
    savePreferences: (body) => client.call('notifications.preferences.update', { body }),
    subscriptions: (type) =>
      client.call('notifications.subscriptions.list', type ? { query: { type } } : undefined),
    subscribe: (type, entityId) =>
      client.call('notifications.subscribe', { params: { type, entityId } }),
    unsubscribe: (type, entityId) =>
      client.call('notifications.unsubscribe', { params: { type, entityId } }),
    rule: () => client.call('notifications.rules.get'),
    saveRule: (body) => client.call('notifications.rules.update', { body }),
    failedDeliveries: () => client.call('notifications.deliveries.failed'),
  };
}
