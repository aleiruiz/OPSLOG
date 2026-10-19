import type { BffRouteDefinition } from './shared.js';

/** Kinds of notice (MVP-NOTIFY). The domain catalog is checked against this list by the drift test. */
export const BFF_NOTIFICATION_KINDS = [
  'document_expiring',
  'maintenance_upcoming',
  'maintenance_overdue',
  'incident_created',
  'incident_status_changed',
  'incident_sla',
  'vehicle_out_of_service',
  'work_order_assigned',
  'membership_created',
  'membership_role_changed',
  'export_ready',
  'export_failed',
] as const;
export type BffNotificationKind = (typeof BFF_NOTIFICATION_KINDS)[number];

export type BffNotificationSeverity = 'info' | 'attention' | 'important' | 'critical';
export type BffNotificationEntityType =
  | 'vehicle'
  | 'incident'
  | 'work_order'
  | 'maintenance_plan'
  | 'employee'
  | 'export'
  | 'member';

/** What can be followed. */
export const BFF_SUBSCRIPTION_TYPES = ['vehicle', 'incident'] as const;
export type BffSubscriptionType = (typeof BFF_SUBSCRIPTION_TYPES)[number];

/** A notice: a label, a kind and a link. Never a personal datum, an amount or free text of a record. */
export interface BffNotification {
  readonly id: string;
  readonly eventKind: BffNotificationKind;
  readonly entityType: BffNotificationEntityType;
  readonly entityId: string;
  readonly title: string;
  /** App path of the entity (starts with `/`). */
  readonly link: string;
  readonly severity: BffNotificationSeverity;
  readonly createdAt: string;
  /** `null`: unread. */
  readonly readAt: string | null;
}

export interface BffNotificationList {
  readonly items: readonly BffNotification[];
  readonly total: number;
  /** Unread notices of the person, whatever the filter. */
  readonly unread: number;
  readonly offset: number;
  readonly limit: number;
}

export interface BffNotificationsQuery {
  /** `true`: only unread. */
  readonly unread?: 'true' | 'false';
  readonly kind?: BffNotificationKind;
  readonly limit?: number;
  readonly offset?: number;
}

export interface BffUnreadCount {
  readonly unread: number;
}
export interface BffReadAllResult {
  readonly changed: number;
}

/** One row of the person's matrix of kinds by channel. */
export interface BffNotificationPreference {
  readonly eventKind: BffNotificationKind;
  readonly label: string;
  readonly description: string;
  /** Fixed on: the person cannot switch it off. */
  readonly mandatory: boolean;
  readonly inApp: boolean;
  readonly email: boolean;
  /** The company lets this kind be e-mailed and this module sends it. */
  readonly emailAvailable: boolean;
}
export interface BffNotificationPreferences {
  readonly items: readonly BffNotificationPreference[];
}
export interface BffNotificationPreferenceInput {
  readonly items: readonly {
    readonly eventKind: BffNotificationKind;
    readonly inApp: boolean;
    readonly email: boolean;
  }[];
}

export interface BffSubscription {
  readonly entityType: BffSubscriptionType;
  readonly entityId: string;
  readonly createdAt: string;
}
export interface BffSubscriptionList {
  readonly items: readonly BffSubscription[];
}

/** What the company allows (FR-152): the kinds that may be e-mailed and the quiet hours. */
export interface BffNotificationRule {
  readonly emailKinds: readonly BffNotificationKind[];
  /** 22:00 to 07:00 in the company's zone for external channels. */
  readonly quietHours: boolean;
  readonly updatedAt: string | null;
}
export interface BffNotificationRuleInput {
  readonly emailKinds: readonly BffNotificationKind[];
  readonly quietHours: boolean;
}

/** A delivery that ran out of attempts: the kind and a code, never an address or a message. */
export interface BffFailedDelivery {
  readonly notificationId: string;
  readonly eventKind: BffNotificationKind;
  readonly channel: 'in_app' | 'email';
  readonly attempts: number;
  readonly lastError: string | null;
  readonly updatedAt: string;
}
export interface BffFailedDeliveryList {
  readonly items: readonly BffFailedDelivery[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

export interface NotificationRouteTypes {
  'notifications.list': { query?: BffNotificationsQuery; response: BffNotificationList };
  'notifications.count': { response: BffUnreadCount };
  'notifications.read': { params: { notificationId: string }; response: BffNotification };
  'notifications.readAll': { response: BffReadAllResult };
  'notifications.preferences.get': { response: BffNotificationPreferences };
  'notifications.preferences.update': {
    body: BffNotificationPreferenceInput;
    response: BffNotificationPreferences;
  };
  'notifications.subscriptions.list': {
    query?: { readonly type?: BffSubscriptionType };
    response: BffSubscriptionList;
  };
  'notifications.subscribe': {
    params: { type: BffSubscriptionType; entityId: string };
    response: BffSubscription;
  };
  'notifications.unsubscribe': {
    params: { type: BffSubscriptionType; entityId: string };
    response: void;
  };
  'notifications.rules.get': { response: BffNotificationRule };
  'notifications.rules.update': { body: BffNotificationRuleInput; response: BffNotificationRule };
  'notifications.deliveries.failed': {
    query?: { readonly limit?: number; readonly offset?: number };
    response: BffFailedDeliveryList;
  };
}

export const NOTIFICATION_ROUTES = {
  'notifications.list': {
    method: 'GET',
    path: ['api', 'v1', 'notifications'],
    kind: 'session',
    status: 200,
  },
  // Literal segments go before the `:notificationId` ones in the BFF table.
  'notifications.count': {
    method: 'GET',
    path: ['api', 'v1', 'notifications', 'unread-count'],
    kind: 'session',
    status: 200,
  },
  'notifications.readAll': {
    method: 'POST',
    path: ['api', 'v1', 'notifications', 'read-all'],
    kind: 'session-csrf',
    status: 200,
  },
  'notifications.read': {
    method: 'POST',
    path: ['api', 'v1', 'notifications', ':notificationId', 'read'],
    kind: 'session-csrf',
    status: 200,
  },
  'notifications.preferences.get': {
    method: 'GET',
    path: ['api', 'v1', 'notification-preferences'],
    kind: 'session',
    status: 200,
  },
  'notifications.preferences.update': {
    method: 'PUT',
    path: ['api', 'v1', 'notification-preferences'],
    kind: 'session-csrf',
    status: 200,
  },
  'notifications.subscriptions.list': {
    method: 'GET',
    path: ['api', 'v1', 'subscriptions'],
    kind: 'session',
    status: 200,
  },
  'notifications.subscribe': {
    method: 'PUT',
    path: ['api', 'v1', 'subscriptions', ':type', ':entityId'],
    kind: 'session-csrf',
    status: 200,
  },
  'notifications.unsubscribe': {
    method: 'DELETE',
    path: ['api', 'v1', 'subscriptions', ':type', ':entityId'],
    kind: 'session-csrf',
    status: 204,
  },
  'notifications.rules.get': {
    method: 'GET',
    path: ['api', 'v1', 'notification-rules'],
    kind: 'session',
    status: 200,
  },
  'notifications.rules.update': {
    method: 'PUT',
    path: ['api', 'v1', 'notification-rules'],
    kind: 'session-csrf',
    status: 200,
  },
  'notifications.deliveries.failed': {
    method: 'GET',
    path: ['api', 'v1', 'notification-deliveries', 'failed'],
    kind: 'session',
    status: 200,
  },
} as const satisfies Record<keyof NotificationRouteTypes, BffRouteDefinition>;
