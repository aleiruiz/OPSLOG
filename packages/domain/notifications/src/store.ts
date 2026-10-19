import type { Channel, SubscriptionType } from './catalog.js';
import type { NotificationStore } from './ports.js';
import type {
  CompanyRule,
  DeliveryOutcome,
  DeliveryWork,
  NewDelivery,
  NewNotification,
  Notification,
  NotificationDelivery,
  NotificationFilter,
  NotificationWindow,
  Preference,
  Subscription,
} from './types.js';

const scoped = (tenantId: string, ...parts: readonly string[]): string =>
  [tenantId, ...parts].map((part) => `${part.length}:${part}`).join('');

const newestFirst = (a: Notification, b: Notification): number =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/** In-memory store for tests and the memory runtime. It follows the rules of the MySQL one. */
export class InMemoryNotificationStore implements NotificationStore {
  private readonly notifications = new Map<string, Notification>();
  private readonly dedupe = new Set<string>();
  private readonly deliveryRows = new Map<string, NotificationDelivery>();
  private readonly prefs = new Map<string, Preference>();
  private readonly rules = new Map<string, CompanyRule>();
  private readonly subs = new Map<string, Subscription>();

  public async create(
    notification: NewNotification,
    deliveries: readonly NewDelivery[],
  ): Promise<boolean> {
    const { dateVersion, threshold, ...stored } = notification;
    const key = scoped(
      notification.tenantId,
      notification.eventKind,
      notification.entityId,
      dateVersion,
      threshold,
      notification.recipientId,
    );
    if (this.dedupe.has(key)) return false;
    this.dedupe.add(key);
    this.notifications.set(scoped(notification.tenantId, notification.id), {
      ...stored,
      readAt: null,
    });
    for (const delivery of deliveries)
      this.deliveryRows.set(scoped(notification.tenantId, notification.id, delivery.channel), {
        tenantId: notification.tenantId,
        notificationId: notification.id,
        channel: delivery.channel,
        status: delivery.status,
        attempts: 0,
        lastError: null,
        nextAttemptAt: delivery.nextAttemptAt,
        leaseUntil: null,
        updatedAt: notification.createdAt,
      });
    return true;
  }

  private mine(tenantId: string, recipientId: string, filter: NotificationFilter) {
    return [...this.notifications.values()]
      .filter(
        (n) =>
          n.tenantId === tenantId &&
          n.recipientId === recipientId &&
          n.inApp &&
          filter.kinds.includes(n.eventKind) &&
          (filter.kind === undefined || n.eventKind === filter.kind) &&
          (!filter.unreadOnly || n.readAt === null),
      )
      .sort(newestFirst);
  }

  public async list(
    tenantId: string,
    recipientId: string,
    filter: NotificationFilter,
    window: NotificationWindow,
  ) {
    const all = this.mine(tenantId, recipientId, filter);
    return { items: all.slice(window.offset, window.offset + window.limit), total: all.length };
  }

  public async unread(tenantId: string, recipientId: string, kinds: NotificationFilter['kinds']) {
    return this.mine(tenantId, recipientId, { kinds, unreadOnly: true }).length;
  }

  public async markRead(
    tenantId: string,
    recipientId: string,
    ids: readonly string[] | null,
    kinds: NotificationFilter['kinds'],
    at: string,
  ) {
    let changed = 0;
    for (const n of this.mine(tenantId, recipientId, { kinds, unreadOnly: true })) {
      if (ids !== null && !ids.includes(n.id)) continue;
      this.notifications.set(scoped(tenantId, n.id), { ...n, readAt: at });
      changed += 1;
    }
    return changed;
  }

  public async find(tenantId: string, recipientId: string, id: string) {
    const found = this.notifications.get(scoped(tenantId, id));
    return found?.recipientId === recipientId ? found : null;
  }

  public async claimDue(
    tenantId: string,
    now: Date,
    leaseMs: number,
    limit: number,
  ): Promise<readonly DeliveryWork[]> {
    const at = now.toISOString();
    const due = [...this.deliveryRows.values()]
      .filter(
        (d) =>
          d.tenantId === tenantId &&
          d.status === 'pending' &&
          (d.nextAttemptAt === null || d.nextAttemptAt <= at) &&
          (d.leaseUntil === null || d.leaseUntil <= at),
      )
      .sort((a, b) => (a.nextAttemptAt ?? '').localeCompare(b.nextAttemptAt ?? ''))
      .slice(0, limit);
    const work: DeliveryWork[] = [];
    for (const d of due) {
      const claimed = { ...d, leaseUntil: new Date(now.getTime() + leaseMs).toISOString() };
      this.deliveryRows.set(scoped(tenantId, d.notificationId, d.channel), claimed);
      const notification = this.notifications.get(scoped(tenantId, d.notificationId));
      if (notification) work.push({ delivery: claimed, notification });
    }
    return work;
  }

  public async settle(
    tenantId: string,
    notificationId: string,
    channel: Channel,
    outcome: DeliveryOutcome,
    at: string,
  ) {
    const key = scoped(tenantId, notificationId, channel);
    const current = this.deliveryRows.get(key);
    if (current?.status !== 'pending') return false;
    const base = { ...current, updatedAt: at, leaseUntil: null };
    if (outcome.status === 'deferred')
      this.deliveryRows.set(key, { ...base, nextAttemptAt: outcome.nextAttemptAt });
    else if (outcome.status === 'suppressed')
      this.deliveryRows.set(key, {
        ...base,
        status: 'suppressed',
        lastError: outcome.reason,
        nextAttemptAt: null,
      });
    else if (outcome.status === 'sent')
      this.deliveryRows.set(key, {
        ...base,
        status: 'sent',
        attempts: current.attempts + 1,
        nextAttemptAt: null,
      });
    else if (outcome.status === 'retry')
      this.deliveryRows.set(key, {
        ...base,
        attempts: current.attempts + 1,
        lastError: outcome.error,
        nextAttemptAt: outcome.nextAttemptAt,
      });
    else
      this.deliveryRows.set(key, {
        ...base,
        status: 'failed',
        attempts: current.attempts + 1,
        lastError: outcome.error,
        nextAttemptAt: null,
      });
    return true;
  }

  public async deliveries(tenantId: string, notificationId: string) {
    return [...this.deliveryRows.values()].filter(
      (d) => d.tenantId === tenantId && d.notificationId === notificationId,
    );
  }

  public async failed(tenantId: string, window: NotificationWindow) {
    const all = [...this.deliveryRows.values()]
      .filter((d) => d.tenantId === tenantId && d.status === 'failed')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const items = all.slice(window.offset, window.offset + window.limit).flatMap((d) => {
      const n = this.notifications.get(scoped(tenantId, d.notificationId));
      return n
        ? [
            {
              notificationId: d.notificationId,
              eventKind: n.eventKind,
              channel: d.channel,
              attempts: d.attempts,
              lastError: d.lastError,
              updatedAt: d.updatedAt,
            },
          ]
        : [];
    });
    return { items, total: all.length };
  }

  public async preferences(tenantId: string, recipientId: string) {
    return [...this.prefs.entries()]
      .filter(([key]) => key.startsWith(scoped(tenantId, recipientId)))
      .map(([, preference]) => preference);
  }

  public async savePreferences(
    tenantId: string,
    recipientId: string,
    preferences: readonly Preference[],
  ) {
    for (const preference of preferences)
      this.prefs.set(scoped(tenantId, recipientId, preference.eventKind), { ...preference });
  }

  public async rule(tenantId: string) {
    return this.rules.get(tenantId) ?? null;
  }

  public async saveRule(tenantId: string, rule: CompanyRule) {
    this.rules.set(tenantId, { ...rule, emailKinds: [...rule.emailKinds] });
  }

  public async subscribe(subscription: Subscription) {
    const key = scoped(
      subscription.tenantId,
      subscription.recipientId,
      subscription.entityType,
      subscription.entityId,
    );
    if (!this.subs.has(key)) this.subs.set(key, { ...subscription });
  }

  public async unsubscribe(
    tenantId: string,
    recipientId: string,
    type: SubscriptionType,
    entityId: string,
  ) {
    return this.subs.delete(scoped(tenantId, recipientId, type, entityId));
  }

  public async subscriptionsOf(tenantId: string, recipientId: string, type?: SubscriptionType) {
    return [...this.subs.values()]
      .filter(
        (s) =>
          s.tenantId === tenantId &&
          s.recipientId === recipientId &&
          (type === undefined || s.entityType === type),
      )
      .sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.entityId.localeCompare(b.entityId),
      );
  }

  public async subscribersOf(tenantId: string, type: SubscriptionType, entityId: string) {
    return [...this.subs.values()]
      .filter((s) => s.tenantId === tenantId && s.entityType === type && s.entityId === entityId)
      .map((s) => s.recipientId)
      .sort();
  }
}
