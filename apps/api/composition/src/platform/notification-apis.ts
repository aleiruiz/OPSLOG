import type { AlertService } from '../../../../../packages/domain/alerts/src/index.js';
import type { ExportJobStore } from '../../../../../packages/domain/exports/src/index.js';
import type { IncidentStore } from '../../../../../packages/domain/incidents/cases/src/index.js';
import type { IncidentSlaModule } from './incident-sla-apis.js';
import type { WorkOrderStore } from '../../../../../packages/domain/maintenance/orders/src/index.js';
import type { PlanStore } from '../../../../../packages/domain/maintenance/plans/src/index.js';
import type { MechanicStore } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import {
  InMemoryNotificationStore,
  NotificationDispatcher,
  NotificationIngest,
  NotificationService,
  type NotificationEnvelope,
  type NotificationEvents,
  type NotificationStore,
} from '../../../../../packages/domain/notifications/src/index.js';
import type { ReportCatalog } from '../../../../../packages/domain/reports/src/index.js';
import type { VehicleStore } from '../../../../../packages/domain/vehicles/src/index.js';
import type { MailPort } from '../../../../../packages/platform/mail/src/index.js';
import { NotificationsApi } from '../../../notifications/src/index.js';
import type { HandlerDeps } from '../../../../worker/notifications/src/index.js';
import { VehiclesApi, type VehiclesApiDeps } from '../vehicles.js';
import { alertMembers, syntheticAddresses } from './incident-sla-apis.js';
import type { PlatformKernel } from './kernel.js';
import { selectMail } from './mail-port.js';
import {
  notificationDirectory,
  notificationSources,
  notificationVisibility,
  type NotificationReaders,
} from './notification-sources.js';
import type { PlatformAdapters } from './types.js';

/** The actor of the events the center writes itself; the worker does not gate system actors by role. */
const SYSTEM_ACTOR = { subject: 'system:notifications', kind: 'system' } as const;

export interface NotificationsModule {
  readonly api: NotificationsApi;
  readonly service: NotificationService;
  readonly ingest: NotificationIngest;
  readonly dispatcher: NotificationDispatcher;
  readonly store: NotificationStore;
  /** What the worker registers and runs. */
  readonly worker: HandlerDeps;
  readonly mail: MailPort;
  readonly events: NotificationEvents;
}

export interface NotificationApis {
  readonly notifications: NotificationsModule;
}

/**
 * Where the center writes the events no module publishes. A durable store writes them in its own
 * transaction; in memory they go through the platform outbox. Either way the worker reads them.
 */
export function notificationEvents(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
): NotificationEvents {
  if (adapters.notificationEvents) return adapters.notificationEvents;
  return {
    publish: async (event: NotificationEnvelope) => {
      await kernel.outbox.transaction((tx) => {
        tx.enqueue({
          eventId: event.eventId,
          tenantId: event.tenantId,
          type: event.type,
          payload: event.payload,
          occurredAt: event.occurredAt,
          idempotencyKey: event.eventId,
          correlationId: event.eventId,
          actorRef: SYSTEM_ACTOR,
          entityId: event.entityId,
          schemaVersion: 1,
        });
      });
    },
  };
}

/**
 * A fact that no module publishes becomes an event after the command committed. A failure here is
 * swallowed: a notification never reverts the command that caused it.
 */
export function emitFact(
  kernel: PlatformKernel,
  events: NotificationEvents,
  type: string,
  tenantId: string,
  entityId: string,
  eventId: string,
  payload: NotificationEnvelope['payload'],
): Promise<void> {
  return events
    .publish({ eventId, tenantId, type, payload, occurredAt: kernel.now().toISOString(), entityId })
    .catch(() => undefined);
}

/** The vehicle API that also tells the center when a vehicle changes status. */
export class NotifyingVehiclesApi extends VehiclesApi {
  public constructor(
    deps: VehiclesApiDeps,
    private readonly after: (
      token: string,
      correlationId: string,
      vehicle: { readonly id: string; readonly status: string; readonly version: number },
    ) => Promise<void>,
  ) {
    super(deps);
  }

  public override async changeStatus(
    ...args: Parameters<VehiclesApi['changeStatus']>
  ): ReturnType<VehiclesApi['changeStatus']> {
    const result = await super.changeStatus(...args);
    if (result.ok && result.value) await this.after(args[0], args[1], result.value);
    return result;
  }
}

/** The hook of the vehicle API: resolves the company of the session and publishes the status fact. */
export function vehicleStatusNotifier(kernel: PlatformKernel, events: NotificationEvents) {
  return async (
    token: string,
    correlationId: string,
    vehicle: { readonly id: string; readonly status: string; readonly version: number },
  ): Promise<void> => {
    try {
      const context = await kernel.authorize(token, correlationId, []);
      await emitFact(
        kernel,
        events,
        'vehicle.status_changed',
        context.tenantId,
        vehicle.id,
        `vehicle-status-${vehicle.id}-v${vehicle.version}`,
        { vehicleId: vehicle.id, status: vehicle.status, version: vehicle.version },
      );
    } catch {
      // The session ended between the command and this call: there is no one to tell.
    }
  };
}

export interface NotificationInputs {
  readonly vehicles: VehicleStore;
  readonly incidents: IncidentStore;
  readonly orders: WorkOrderStore;
  readonly plans: PlanStore;
  readonly mechanics: MechanicStore;
  readonly sla: IncidentSlaModule;
  readonly exportJobs: ExportJobStore;
  readonly catalog: ReportCatalog;
  readonly alerts: AlertService;
  readonly settings: NotificationReaders['settings'];
  /** Base of the links in the e-mails (the public origin of the web app). */
  readonly baseUrl?: string | undefined;
}

/**
 * Notification center: the service the API uses, the ingest and dispatcher the worker runs, and
 * the readers over the other modules. Memory unless a persistent store is injected.
 */
export function buildNotifications(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  input: NotificationInputs,
): NotificationsModule {
  const store = adapters.notifications ?? new InMemoryNotificationStore();
  const mail = selectMail(adapters);
  const addresses = adapters.incidentAlertAddresses ?? syntheticAddresses;
  const readers: NotificationReaders = {
    ...input,
    exportJobs: input.exportJobs,
    reportTitle: (id) => input.catalog.get(id)?.title,
    sla: { store: input.sla.store, members: alertMembers(kernel, adapters) },
    addresses,
  };
  const directory = notificationDirectory(kernel, readers);
  const visibility = notificationVisibility(readers);
  const common = { store, directory, visibility, now: kernel.now };
  const ingest = new NotificationIngest(common);
  const service = new NotificationService(common);
  const sources = notificationSources(kernel, readers);
  const authorize = async (token: string, correlationId: string) => {
    const context = await kernel.authorize(token, correlationId, []);
    const access = await directory.access(context.tenantId, context.actor.subject);
    return {
      tenantId: context.tenantId,
      subject: context.actor.subject,
      // Re-resolved now, like every API of the platform: a role changed a second ago already counts.
      permissions: access?.permissions ?? [],
      mechanicLinked: access?.mechanicLinked ?? false,
    };
  };
  const events = notificationEvents(kernel, adapters);
  kernel.membership = async (kind, tenantId, identityId, role) => {
    const version = kernel.now().getTime();
    await emitFact(
      kernel,
      events,
      `membership.${kind}`,
      tenantId,
      identityId,
      `membership-${kind}-${identityId}-${version}`,
      { memberId: identityId, role, version },
    );
  };
  return {
    api: new NotificationsApi({ authorize, service }),
    service,
    ingest,
    dispatcher: new NotificationDispatcher({
      ...common,
      mail,
      baseUrl: input.baseUrl,
      random: Math.random,
    }),
    store,
    worker: { ingest, sources, now: kernel.now },
    mail,
    events,
  };
}
