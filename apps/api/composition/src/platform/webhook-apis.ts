import type {
  EmployeeService,
  EmployeeStore,
} from '../../../../../packages/domain/employees/src/index.js';
import type { IncidentStore } from '../../../../../packages/domain/incidents/cases/src/index.js';
import type { WorkOrderStore } from '../../../../../packages/domain/maintenance/orders/src/index.js';
import type { NotificationEvents } from '../../../../../packages/domain/notifications/src/index.js';
import type { VehicleStore } from '../../../../../packages/domain/vehicles/src/index.js';
import {
  EligibilityTracker,
  InMemoryWebhookStore,
  SecretVault,
  WebhookDispatcher,
  WebhookIngest,
  WebhookService,
  type DriverFacts,
  type DriverSource,
} from '../../../../../packages/domain/webhooks/src/index.js';
import type { MailPort } from '../../../../../packages/platform/mail/src/index.js';
import {
  SafeWebhookClient,
  validateDestination,
} from '../../../../../packages/platform/webhooks/src/index.js';
import { WebhooksApi } from '../../../webhooks/src/index.js';
import type { WebhookSources } from '../../../../worker/webhooks/src/index.js';
import type { Employee } from '../../../../../packages/domain/employees/src/index.js';
import { emitFact } from './notification-apis.js';
import { resolvePiiCipher } from './pii-cipher.js';
import type { PlatformKernel } from './kernel.js';
import type { PlatformAdapters } from './types.js';

export interface WebhooksModule {
  readonly api: WebhooksApi;
  readonly service: WebhookService;
  readonly ingest: WebhookIngest;
  readonly dispatcher: WebhookDispatcher;
  readonly tracker: EligibilityTracker;
  readonly store: NonNullable<PlatformAdapters['webhooks']>;
  /** What the worker registers and runs. */
  readonly worker: {
    readonly ingest: WebhookIngest;
    readonly tracker: EligibilityTracker;
    readonly drivers: DriverSource;
    readonly sources: WebhookSources;
    readonly now: () => Date;
  };
}

export interface WebhookApis {
  readonly webhooks: WebhooksModule;
}

export interface WebhookInputs {
  readonly vehicles: VehicleStore;
  readonly incidents: IncidentStore;
  readonly orders: WorkOrderStore;
  readonly employeeStore: EmployeeStore;
  readonly employees: EmployeeService;
  /** Administrators are told here when an endpoint is switched off. */
  readonly holders: (
    tenantId: string,
    permission: 'integrations:manage',
  ) => Promise<readonly string[]>;
  readonly addressOf: (tenantId: string, actorId: string) => Promise<string | null>;
  readonly mail: MailPort;
}

/** The driver the webhooks announce: fit or not, with the codes of why (no license data, no name). */
function factsOf(service: EmployeeService, employee: Employee): DriverFacts | null {
  const fitness = service.fitness(employee);
  return fitness === null
    ? null
    : { id: employee.id, eligible: fitness.fit, reasons: [...fitness.reasons] };
}

export function driverSource(store: EmployeeStore, service: EmployeeService): DriverSource {
  return {
    driver: async (tenantId, driverId) => {
      const found = await store.find(tenantId, driverId);
      return found ? factsOf(service, found) : null;
    },
    drivers: async (tenantId) => {
      const found: DriverFacts[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await store.list(
          tenantId,
          { kind: 'driver', includeArchived: false },
          { limit: 100, offset },
        );
        for (const employee of page.items) {
          const facts = factsOf(service, employee);
          if (facts) found.push(facts);
        }
        if (offset + 100 >= page.total) break;
      }
      return found;
    },
  };
}

export function webhookSources(inputs: WebhookInputs): WebhookSources {
  return {
    vehicle: async (tenantId, id) => {
      const found = await inputs.vehicles.find(tenantId, id);
      return found ? { economicNumber: found.economicNumber, status: found.status } : null;
    },
    incident: async (tenantId, id) => {
      const found = await inputs.incidents.get(tenantId, id);
      return found ? { folio: found.folio, vehicleId: found.vehicleId } : null;
    },
    order: async (tenantId, id) => {
      const found = await inputs.orders.get(tenantId, id);
      return found ? { status: found.status, vehicleId: found.vehicleId } : null;
    },
  };
}

/**
 * Outgoing webhooks: the administration API, the ingest and dispatcher the worker runs and the
 * readers over the other modules. Memory unless a persistent store is injected. The signing client
 * resolves DNS and connects itself (SPECS §4.3); tests inject a resolver and a client.
 */
export function buildWebhooks(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  inputs: WebhookInputs,
): WebhooksModule {
  if (adapters.webhooks && !adapters.pii)
    throw new Error('adapters.webhooks requires adapters.pii (no local KMS fallback)');
  const store = adapters.webhooks ?? new InMemoryWebhookStore();
  const vault = new SecretVault(resolvePiiCipher(adapters));
  const ingest = new WebhookIngest({ store, now: kernel.now });
  const service = new WebhookService({
    store,
    vault,
    ingest,
    now: kernel.now,
    validateUrl: (url) => validateDestination(url, adapters.webhookResolver),
  });
  const drivers = driverSource(inputs.employeeStore, inputs.employees);
  const tracker = new EligibilityTracker({ store, source: drivers, ingest, now: kernel.now });
  const dispatcher = new WebhookDispatcher({
    store,
    vault,
    client:
      adapters.webhookClient ??
      new SafeWebhookClient(adapters.webhookResolver ? { resolve: adapters.webhookResolver } : {}),
    now: kernel.now,
    notifier: {
      disabled: async (tenantId, endpointId) => {
        // Told through the mail port of the notification center; a failed mail never undoes the switch-off.
        for (const holder of await inputs.holders(tenantId, 'integrations:manage')) {
          const to = await inputs.addressOf(tenantId, `user-${holder}`);
          if (to === null) continue;
          await inputs.mail
            .send({
              companyId: tenantId,
              to,
              subject: `${kernel.tenantName(tenantId)}: un webhook se desactivó`,
              text: 'Un endpoint de webhooks falló 20 veces seguidas y se desactivó. Revísalo en Configuración, Integraciones y actívalo de nuevo cuando el receptor responda.',
              template: 'webhook_disabled',
              idempotencyKey: `webhook-disabled:${endpointId}:${holder}`,
            })
            .catch(() => undefined);
        }
      },
    },
  });
  const api = new WebhooksApi({
    service,
    authorize: (token, correlationId, required) => kernel.authorize(token, correlationId, required),
    audit: (context, action, entityId, correlationId) =>
      kernel.auditNow(
        kernel.userActor(context),
        action,
        'webhook_endpoint',
        entityId,
        correlationId,
      ),
  });
  return {
    api,
    service,
    ingest,
    dispatcher,
    tracker,
    store,
    worker: { ingest, tracker, drivers, sources: webhookSources(inputs), now: kernel.now },
  };
}

type Fact = {
  readonly id: string;
  readonly version: number;
};

/** After a vehicle was created or updated, the fact that no module publishes becomes an outbox event. */
export function vehicleWriteNotifier(kernel: PlatformKernel, events: NotificationEvents) {
  return async (
    kind: 'created' | 'updated',
    token: string,
    correlationId: string,
    vehicle: Fact,
  ): Promise<void> => {
    try {
      const context = await kernel.authorize(token, correlationId, []);
      await emitFact(
        kernel,
        events,
        `vehicle.${kind}`,
        context.tenantId,
        vehicle.id,
        `vehicle-${kind}-${vehicle.id}-v${vehicle.version}`,
        { vehicleId: vehicle.id, version: vehicle.version },
      );
    } catch {
      // The session ended between the command and this call: there is no one to tell.
    }
  };
}

/** The hook of the employees API: drivers only; every change after the first is `driver.updated`. */
export function driverWriteNotifier(kernel: PlatformKernel, events: NotificationEvents) {
  return async (
    tenantId: string,
    action: string,
    employee: { readonly id: string; readonly kind: string; readonly version: number },
  ): Promise<void> => {
    if (employee.kind !== 'driver' || action === 'employee.pii_viewed') return;
    const kind = action === 'employee.created' ? 'created' : 'updated';
    await emitFact(
      kernel,
      events,
      `driver.${kind}`,
      tenantId,
      employee.id,
      `driver-${kind}-${employee.id}-v${employee.version}`,
      { driverId: employee.id, version: employee.version },
    );
  };
}
