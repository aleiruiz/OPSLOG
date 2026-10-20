import {
  createNotificationDataSource,
  createNotificationMigrationDataSource,
  NOTIFICATION_MIGRATION_VERSION,
  runNotificationMigrations,
  TypeOrmNotificationStore,
  type NotificationDatabaseConfig,
} from '../../../../packages/persistence/notifications/src/index.js';

type Endpoint = Pick<NotificationDatabaseConfig, 'host' | 'port' | 'database'>;
type Account = Pick<NotificationDatabaseConfig, 'username' | 'password'>;

/** Notification schema step: after the audit and outbox its events are written to. */
export function notificationsMigrationSteps(endpoint: Endpoint, migrator: Account) {
  return [
    {
      name: 'notifications',
      version: NOTIFICATION_MIGRATION_VERSION,
      source: createNotificationMigrationDataSource({ ...endpoint, ...migrator }),
      run: runNotificationMigrations,
    },
  ] as const;
}

/** Uninitialized notifications source; the caller initializes it so a failed startup closes it. */
export function createNotificationsRuntimeSource(
  endpoint: Omit<NotificationDatabaseConfig, 'username' | 'password'>,
  account: Account,
) {
  return createNotificationDataSource({ ...endpoint, ...account });
}

/** One store: the center itself and the writer of the events no module publishes (same transaction as the outbox). */
export function notificationsRuntimeAdapters(
  source: ReturnType<typeof createNotificationsRuntimeSource>,
) {
  const store = new TypeOrmNotificationStore(source);
  return { notifications: store, notificationEvents: store };
}
