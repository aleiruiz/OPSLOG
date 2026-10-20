import type {
  BffClient,
  BffWebhookDelivery,
  BffWebhookDeliveryList,
  BffWebhookEndpoint,
  BffWebhookEndpointInput,
  BffWebhookEndpointList,
  BffWebhookEndpointPatch,
  BffWebhookSecret,
} from '@opslog/contracts';
import type { Result } from '../../app/types';

/** What the integrations screen needs from the BFF. The secret only ever comes back from `create` and `rotate`. */
export interface IntegrationsPorts {
  list(): Promise<Result<BffWebhookEndpointList>>;
  create(input: BffWebhookEndpointInput): Promise<Result<BffWebhookSecret>>;
  update(endpointId: string, input: BffWebhookEndpointPatch): Promise<Result<BffWebhookEndpoint>>;
  remove(endpointId: string): Promise<Result<void>>;
  rotate(endpointId: string, version: number): Promise<Result<BffWebhookSecret>>;
  test(endpointId: string): Promise<Result<BffWebhookDelivery>>;
  deliveries(
    endpointId: string,
    query?: { limit?: number; offset?: number },
  ): Promise<Result<BffWebhookDeliveryList>>;
  retry(endpointId: string, deliveryId: string): Promise<Result<BffWebhookDelivery>>;
}

export function createIntegrationsPorts(client: BffClient): IntegrationsPorts {
  return {
    list: () => client.call('webhooks.list'),
    create: (body) => client.call('webhooks.create', { body }),
    update: (endpointId, body) => client.call('webhooks.update', { params: { endpointId }, body }),
    remove: (endpointId) => client.call('webhooks.delete', { params: { endpointId } }),
    rotate: (endpointId, version) =>
      client.call('webhooks.rotate', { params: { endpointId }, body: { version } }),
    test: (endpointId) => client.call('webhooks.test', { params: { endpointId } }),
    deliveries: (endpointId, query) =>
      client.call('webhooks.deliveries', { params: { endpointId }, ...(query ? { query } : {}) }),
    retry: (endpointId, deliveryId) =>
      client.call('webhooks.retry', { params: { endpointId, deliveryId } }),
  };
}
