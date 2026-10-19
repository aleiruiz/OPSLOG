import type { Permission } from '../../identity/src/index.js';
import type { EntityType, SubscriptionType } from './catalog.js';
import type {
  CompanyRule,
  DeliveryOutcome,
  DeliveryWork,
  FailedDelivery,
  NewDelivery,
  NewNotification,
  Notification,
  NotificationDelivery,
  NotificationFilter,
  NotificationSlice,
  NotificationWindow,
  Preference,
  Subscription,
} from './types.js';

/** What the directory knows of a member now. */
export interface MemberAccess {
  readonly permissions: readonly Permission[];
  /** The member has (or had) a mechanic record: no access to incidents (D9, fail closed). */
  readonly mechanicLinked: boolean;
}

/** Members as the control plane knows them now; the notice is revalidated against it when it is created and when it is sent. */
export interface RecipientDirectory {
  /** `null`: not an active member of an active company. */
  access(tenantId: string, recipientId: string): Promise<MemberAccess | null>;
  /** Where the person's e-mail lives. It goes to the mail port and nowhere else. */
  address(tenantId: string, recipientId: string): Promise<string | null>;
  company(tenantId: string): Promise<{ readonly name: string; readonly timeZone: string }>;
}

/** Whether a member may still see an entity (a follower who lost access stops receiving its notices). */
export interface EntityVisibility {
  visible(
    tenantId: string,
    access: MemberAccess,
    entityType: EntityType,
    entityId: string,
  ): Promise<boolean>;
}

/**
 * Persistence of the notices. Every method names the company: a row of another company is simply
 * absent. `create` writes the notice and its deliveries together or not at all.
 */
export interface NotificationStore {
  /** `false`: the notice already existed for that recipient, entity, date version and threshold. */
  create(notification: NewNotification, deliveries: readonly NewDelivery[]): Promise<boolean>;
  /** Newest first, only the notices of the center (`inApp`). */
  list(
    tenantId: string,
    recipientId: string,
    filter: NotificationFilter,
    window: NotificationWindow,
  ): Promise<NotificationSlice>;
  unread(
    tenantId: string,
    recipientId: string,
    kinds: NotificationFilter['kinds'],
  ): Promise<number>;
  /** Marks as read the notices with these ids, or all of the kinds when `ids` is null; returns how many changed. */
  markRead(
    tenantId: string,
    recipientId: string,
    ids: readonly string[] | null,
    kinds: NotificationFilter['kinds'],
    at: string,
  ): Promise<number>;
  find(tenantId: string, recipientId: string, id: string): Promise<Notification | null>;

  /** Pending deliveries that are due, taken for `leaseMs` so two workers never send the same one. */
  claimDue(
    tenantId: string,
    now: Date,
    leaseMs: number,
    limit: number,
  ): Promise<readonly DeliveryWork[]>;
  /** Writes the outcome only while the delivery is still pending; false otherwise. */
  settle(
    tenantId: string,
    notificationId: string,
    channel: NotificationDelivery['channel'],
    outcome: DeliveryOutcome,
    at: string,
  ): Promise<boolean>;
  deliveries(tenantId: string, notificationId: string): Promise<readonly NotificationDelivery[]>;
  failed(
    tenantId: string,
    window: NotificationWindow,
  ): Promise<{ items: readonly FailedDelivery[]; total: number }>;

  preferences(tenantId: string, recipientId: string): Promise<readonly Preference[]>;
  savePreferences(
    tenantId: string,
    recipientId: string,
    preferences: readonly Preference[],
    at: string,
  ): Promise<void>;
  rule(tenantId: string): Promise<CompanyRule | null>;
  saveRule(tenantId: string, rule: CompanyRule): Promise<void>;

  subscribe(subscription: Subscription): Promise<void>;
  unsubscribe(
    tenantId: string,
    recipientId: string,
    type: SubscriptionType,
    entityId: string,
  ): Promise<boolean>;
  subscriptionsOf(
    tenantId: string,
    recipientId: string,
    type?: SubscriptionType,
  ): Promise<readonly Subscription[]>;
  subscribersOf(
    tenantId: string,
    type: SubscriptionType,
    entityId: string,
  ): Promise<readonly string[]>;
}

/** An event the center puts in the outbox itself, for the facts no module publishes (vehicle status, memberships). */
export interface NotificationEnvelope {
  readonly eventId: string;
  readonly tenantId: string;
  readonly type: string;
  /** Ids, statuses and counters only: never a name, an address or a free text. */
  readonly payload: Readonly<Record<string, string | number>>;
  readonly occurredAt: string;
  readonly entityId: string;
}
export interface NotificationEvents {
  /** Written once per `eventId`: a repeated call changes nothing. */
  publish(envelope: NotificationEnvelope): Promise<void>;
}
