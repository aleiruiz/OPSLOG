import type { IntegrationsPorts } from '../settings/integrations/ports';
import {
  createFakeIntegrations,
  demoDelivery,
  demoEndpoint,
} from '../settings/integrations/fakePorts';
import type { Guarded } from './mockApiTypes';

/** Integrations of the demo API: only people with `integrations:manage` reach them. */
export function createMockIntegrationsPorts(guarded: Guarded): IntegrationsPorts {
  const store = createFakeIntegrations({
    endpoints: [demoEndpoint()],
    deliveries: {
      'wh-1': [
        demoDelivery(),
        demoDelivery({
          id: 'del-2',
          eventId: 'evt-2',
          eventType: 'driver.eligibility_changed',
          status: 'dead_letter',
          attempts: 6,
          lastStatusCode: 503,
          lastError: 'http_503',
        }),
      ],
    },
  });
  const P = 'integrations:manage';
  return {
    list: () => guarded('integrations', P, () => store.list()),
    create: (input) => guarded('integrations', P, () => store.create(input)),
    update: (id, input) => guarded('integrations', P, () => store.update(id, input)),
    remove: (id) => guarded('integrations', P, () => store.remove(id)),
    rotate: (id, version) => guarded('integrations', P, () => store.rotate(id, version)),
    test: (id) => guarded('integrations', P, () => store.test(id)),
    deliveries: (id, query) => guarded('integrations', P, () => store.deliveries(id, query)),
    retry: (id, deliveryId) => guarded('integrations', P, () => store.retry(id, deliveryId)),
  };
}
