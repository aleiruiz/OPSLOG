import { EntitySchema } from 'typeorm';

export const NOTIFICATION_TABLES = {
  notifications: 'opslog_notifications',
  deliveries: 'opslog_notification_deliveries',
  preferences: 'opslog_notification_preferences',
  rules: 'opslog_notification_rules',
  subscriptions: 'opslog_notification_subscriptions',
} as const;

export const BINARY_COLLATION = 'utf8mb4_0900_bin';
const text = (name: string, length: number, nullable = false) => ({
  name,
  type: 'varchar' as const,
  length: String(length),
  collation: BINARY_COLLATION,
  nullable,
});
const instant = (name: string, nullable = false) => ({
  name,
  type: 'datetime' as const,
  precision: 6,
  nullable,
});
const flag = (name: string) => ({
  name,
  type: 'tinyint' as const,
  width: 1,
  transformer: {
    to: (value: boolean) => (value ? 1 : 0),
    from: (value: number | boolean) => value === true || value === 1,
  },
});

export class NotificationEntity {
  tenantId!: string;
  id!: string;
  recipientId!: string;
  eventKind!: string;
  entityType!: string;
  entityId!: string;
  title!: string;
  link!: string;
  severity!: string;
  inApp!: boolean;
  dateVersion!: string;
  threshold!: string;
  createdAt!: Date;
  readAt!: Date | null;
}

export class DeliveryEntity {
  tenantId!: string;
  notificationId!: string;
  channel!: string;
  status!: string;
  attempts!: number;
  lastError!: string | null;
  nextAttemptAt!: Date | null;
  leaseUntil!: Date | null;
  updatedAt!: Date;
}

export class PreferenceEntity {
  tenantId!: string;
  recipientId!: string;
  eventKind!: string;
  inApp!: boolean;
  email!: boolean;
  updatedAt!: Date;
}

export class RuleEntity {
  tenantId!: string;
  emailKinds!: string[];
  quietHours!: boolean;
  updatedAt!: Date | null;
}

export class SubscriptionEntity {
  tenantId!: string;
  recipientId!: string;
  entityType!: string;
  entityId!: string;
  createdAt!: Date;
}

/** One row per notice and person. The unique key is what makes a repeated scan idempotent. */
export const NotificationSchema = new EntitySchema<NotificationEntity>({
  name: 'NotificationEntity',
  target: NotificationEntity,
  tableName: NOTIFICATION_TABLES.notifications,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    id: { ...text('id', 64), primary: true },
    recipientId: text('recipient_id', 128),
    eventKind: text('event_kind', 32),
    entityType: text('entity_type', 24),
    entityId: text('entity_id', 128),
    title: text('title', 160),
    link: text('link', 200),
    severity: text('severity', 12),
    inApp: flag('in_app'),
    dateVersion: text('date_version', 40),
    threshold: text('threshold', 40),
    createdAt: instant('created_at'),
    readAt: instant('read_at', true),
  },
});

/** The send through one channel. It stores a failure code, never a provider message or an address. */
export const DeliverySchema = new EntitySchema<DeliveryEntity>({
  name: 'DeliveryEntity',
  target: DeliveryEntity,
  tableName: NOTIFICATION_TABLES.deliveries,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    notificationId: { ...text('notification_id', 64), primary: true },
    channel: { ...text('channel', 8), primary: true },
    status: text('status', 12),
    attempts: { name: 'attempts', type: 'int' },
    lastError: text('last_error', 48, true),
    nextAttemptAt: instant('next_attempt_at', true),
    leaseUntil: instant('lease_until', true),
    updatedAt: instant('updated_at'),
  },
});

export const PreferenceSchema = new EntitySchema<PreferenceEntity>({
  name: 'PreferenceEntity',
  target: PreferenceEntity,
  tableName: NOTIFICATION_TABLES.preferences,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    recipientId: { ...text('recipient_id', 128), primary: true },
    eventKind: { ...text('event_kind', 32), primary: true },
    inApp: flag('in_app'),
    email: flag('email'),
    updatedAt: instant('updated_at'),
  },
});

export const RuleSchema = new EntitySchema<RuleEntity>({
  name: 'RuleEntity',
  target: RuleEntity,
  tableName: NOTIFICATION_TABLES.rules,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    emailKinds: { name: 'email_kinds', type: 'json' },
    quietHours: flag('quiet_hours'),
    updatedAt: instant('updated_at', true),
  },
});

export const SubscriptionSchema = new EntitySchema<SubscriptionEntity>({
  name: 'SubscriptionEntity',
  target: SubscriptionEntity,
  tableName: NOTIFICATION_TABLES.subscriptions,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    recipientId: { ...text('recipient_id', 128), primary: true },
    entityType: { ...text('entity_type', 12), primary: true },
    entityId: { ...text('entity_id', 128), primary: true },
    createdAt: instant('created_at'),
  },
});

export const NOTIFICATION_ENTITIES = [
  NotificationSchema,
  DeliverySchema,
  PreferenceSchema,
  RuleSchema,
  SubscriptionSchema,
];
