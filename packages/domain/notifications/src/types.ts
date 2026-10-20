import type { Channel, EntityType, EventKind, Severity, SubscriptionType } from './catalog.js';

/** One notice for one person. No personal data, amount or free text of a record: a label, a link and a kind. */
export interface Notification {
  readonly id: string;
  /** Company that owns it; every read and write names it. */
  readonly tenantId: string;
  /** Identity subject of the person (without the `user-` prefix). */
  readonly recipientId: string;
  readonly eventKind: EventKind;
  readonly entityType: EntityType;
  readonly entityId: string;
  readonly title: string;
  /** App path of the entity. */
  readonly link: string;
  readonly severity: Severity;
  readonly createdAt: string;
  readonly readAt: string | null;
  /** The notice appears in the center (the person may have kept only the e-mail). */
  readonly inApp: boolean;
}

/** A notice as the ingest decides it: what makes it unique is `(kind, entity, dateVersion, threshold, recipient)`. */
export interface NewNotification extends Omit<Notification, 'readAt'> {
  /** Changes when the date of the entity changes, so a renewed document starts its cycle again. */
  readonly dateVersion: string;
  readonly threshold: string;
}

export const DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'suppressed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** The send of a notice through one channel. It keeps a code, never the provider's message or an address. */
export interface NotificationDelivery {
  readonly tenantId: string;
  readonly notificationId: string;
  readonly channel: Channel;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly lastError: string | null;
  /** Earliest instant of the next attempt: a retry, or the end of the quiet hours. */
  readonly nextAttemptAt: string | null;
  readonly leaseUntil: string | null;
  readonly updatedAt: string;
}

export interface NewDelivery {
  readonly channel: Channel;
  readonly status: DeliveryStatus;
  readonly nextAttemptAt: string | null;
}

export interface DeliveryWork {
  readonly delivery: NotificationDelivery;
  readonly notification: Notification;
}

export type DeliveryOutcome =
  | { readonly status: 'sent' }
  | { readonly status: 'retry'; readonly nextAttemptAt: string; readonly error: string }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'suppressed'; readonly reason: string }
  /** Quiet hours: wait without spending an attempt. */
  | { readonly status: 'deferred'; readonly nextAttemptAt: string };

export interface FailedDelivery {
  readonly notificationId: string;
  readonly eventKind: EventKind;
  readonly channel: Channel;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

export interface Preference {
  readonly eventKind: EventKind;
  readonly inApp: boolean;
  readonly email: boolean;
}

/** What the company allows (FR-152): the notices that may be e-mailed and the quiet hours of external channels. */
export interface CompanyRule {
  readonly emailKinds: readonly EventKind[];
  /** 22:00 to 07:00 in the company's zone; off by default. */
  readonly quietHours: boolean;
  readonly updatedAt: string | null;
}

export interface Subscription {
  readonly tenantId: string;
  readonly recipientId: string;
  readonly entityType: SubscriptionType;
  readonly entityId: string;
  readonly createdAt: string;
}

export interface NotificationWindow {
  readonly limit: number;
  readonly offset: number;
}
export interface NotificationSlice {
  readonly items: readonly Notification[];
  readonly total: number;
}
export interface NotificationFilter {
  /** Only these kinds (the ones the person may still see). */
  readonly kinds: readonly EventKind[];
  readonly unreadOnly?: boolean;
  /** A single kind chosen on the screen. */
  readonly kind?: EventKind;
}

export const DEFAULT_LIST_LIMIT = 25;
export const MAX_LIST_LIMIT = 100;
export const MAX_ATTEMPTS = 4;
export const LEASE_MS = 2 * 60_000;
export const QUIET_START_HOUR = 22;
export const QUIET_END_HOUR = 7;
