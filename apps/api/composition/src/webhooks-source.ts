import {
  createWebhookDataSource,
  createWebhookMigrationDataSource,
  runWebhookMigrations,
  TypeOrmWebhookStore,
  WEBHOOK_MIGRATION_VERSION,
  type WebhookDatabaseConfig,
} from '../../../../packages/persistence/webhooks/src/index.js';

type Endpoint = Pick<WebhookDatabaseConfig, 'host' | 'port' | 'database'>;
type Account = Pick<WebhookDatabaseConfig, 'username' | 'password'>;

/** Webhook schema step: it references no table of another module. */
export function webhooksMigrationSteps(endpoint: Endpoint, migrator: Account) {
  return [
    {
      name: 'webhooks',
      version: WEBHOOK_MIGRATION_VERSION,
      source: createWebhookMigrationDataSource({ ...endpoint, ...migrator }),
      run: runWebhookMigrations,
    },
  ] as const;
}

/** Uninitialized webhooks source; the caller initializes it so a failed startup closes it. */
export function createWebhooksRuntimeSource(
  endpoint: Omit<WebhookDatabaseConfig, 'username' | 'password'>,
  account: Account,
) {
  return createWebhookDataSource({ ...endpoint, ...account });
}

export function webhooksRuntimeAdapters(source: ReturnType<typeof createWebhooksRuntimeSource>) {
  return { webhooks: new TypeOrmWebhookStore(source) };
}
