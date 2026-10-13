import { randomUUID } from 'node:crypto';
import type { IncidentStore } from '../../../../../packages/domain/incidents/cases/src/index.js';
import {
  IncidentAlertDelivery,
  IncidentSlaReader,
  IncidentSlaScanner,
  InMemoryIncidentSlaStore,
  type AlertAddresses,
  type AlertMembers,
  type IncidentAlertMailer,
  type IncidentSlaStore,
  type SlaEvent,
  type SlaSettings,
  type SlaSettingsReader,
} from '../../../../../packages/domain/incidents/sla/src/index.js';
import { InMemoryMechanicStore } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import {
  selectIncidentAlertMailer,
  type TestSinkMailer,
} from '../../../../worker/incident-sla/src/index.js';
import { IncidentSlaApi } from '../../../incidents/sla/src/index.js';
import { ROLE_PERMISSIONS } from '../access.js';
import type { PlatformKernel } from './kernel.js';
import { createMechanicScope } from './mechanic-scope.js';
import type { PlatformAdapters } from './types.js';
import type { IncidentServices } from './incident-apis.js';

/** The actor of the events the SLA writes itself; the worker does not gate system actors by role. */
const SYSTEM_ACTOR = { subject: 'system:incident-sla', kind: 'system' } as const;
const ACTOR_PREFIX = 'user-';

/** The SLA parameters as the company settings hold them now, read on every job. */
export function slaSettingsReader(services: IncidentServices): SlaSettingsReader {
  return {
    settings: async (tenantId): Promise<SlaSettings> => {
      const company = await services.settings.get(tenantId);
      return {
        timeZone: company.timeZone,
        targetDays: company.incidentSlaDays,
        inactivityDays: company.incidentInactivityDays,
      };
    },
  };
}

/** Members as the directory knows them now: role, rights and mechanic link are read at send time. */
export function alertMembers(kernel: PlatformKernel, adapters: PlatformAdapters): AlertMembers {
  const scope = createMechanicScope(adapters.maintenanceMechanics ?? new InMemoryMechanicStore());
  const permissionsOf = async (tenantId: string, identityId: string) => {
    const role = await kernel.access.effectiveRole(tenantId, identityId);
    return role ? ROLE_PERMISSIONS[role] : null;
  };
  return {
    profile: async (tenantId, actorId) => {
      const identityId = actorId.replace(/^user-/, '');
      const permissions = await permissionsOf(tenantId, identityId);
      if (!permissions || kernel.tenants.status(tenantId) !== 'active') return null;
      return { permissions, mechanicLinked: await scope.mechanicLinked(tenantId, identityId) };
    },
    holders: async (tenantId, permission) => {
      const found: string[] = [];
      for (const member of kernel.access.membersOf(tenantId)) {
        if (member.status !== 'active') continue;
        if ((await permissionsOf(tenantId, member.identityId))?.includes(permission))
          found.push(`${ACTOR_PREFIX}${member.identityId}`);
      }
      return found;
    },
  };
}

/**
 * Addresses of the members. The identity contract carries none yet, so unless a deployment injects
 * the real directory the address is a reserved, undeliverable one; it only ever reaches the mail port.
 */
export const syntheticAddresses: AlertAddresses = {
  addressOf: async (_tenantId, actorId) => `${actorId.replace(/^user-/, '')}@alerts.opslog.invalid`,
};

export interface IncidentSlaModule {
  readonly api: IncidentSlaApi;
  readonly reader: IncidentSlaReader;
  readonly scanner: IncidentSlaScanner;
  readonly delivery: IncidentAlertDelivery;
  readonly store: IncidentSlaStore;
  readonly mailer: IncidentAlertMailer;
  /** Queues an `incident.sla.scan` job for the tenant (one case, or all) in its outbox. */
  readonly enqueueScan: (tenantId: string, incidentId?: string) => Promise<void>;
}

/**
 * The incident SLA over the shared incident store: the calculated block, the notices and their
 * e-mail. Memory unless a persistent store is injected. The mail goes through the port; outside
 * production a test sink records it and sends nothing.
 */
export function buildIncidentSla(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  services: IncidentServices,
  incidents: IncidentStore,
  environment: string | undefined,
): IncidentSlaModule {
  const mailer = selectIncidentAlertMailer({
    ...(environment === undefined ? {} : { environment }),
    ...(adapters.incidentAlertMailer ? { mailer: adapters.incidentAlertMailer } : {}),
  });
  // Production needs the real directory too: a reserved address would make every send look done.
  if (environment === 'production' && !adapters.incidentAlertAddresses)
    throw new Error('A member address directory is required for incident alerts in production');
  const store =
    adapters.incidentSla ??
    new InMemoryIncidentSlaStore(incidents, (event: SlaEvent) => {
      // In memory the outbox takes the event inside the same call, so a refusal keeps no notice.
      void kernel.outbox.transaction((tx) => {
        const eventId = event.eventId ?? `evt-${String(event.payload['alertId'])}`;
        tx.enqueue({
          eventId,
          tenantId: event.tenantId,
          type: event.type,
          payload: event.payload,
          occurredAt: event.occurredAt ?? kernel.now().toISOString(),
          idempotencyKey: eventId,
          actorRef: SYSTEM_ACTOR,
          entityId: event.entityId ?? String(event.payload['incidentId']),
          schemaVersion: 1,
        });
      });
    });
  const settings = slaSettingsReader(services);
  const options = { now: kernel.now };
  const reader = new IncidentSlaReader(incidents, store, settings, options);
  const scope = createMechanicScope(adapters.maintenanceMechanics ?? new InMemoryMechanicStore());
  return {
    api: new IncidentSlaApi({
      authorize: async (token, correlationId) => {
        const context = await kernel.authorize(token, correlationId, []);
        return { context, permissions: await kernel.access.resolvePermissions(context) };
      },
      mechanicLinked: scope.mechanicLinked,
      // A refused access is audited like any other denied attempt; the audit trail has no payload.
      deny: (context, action, entityId, correlationId) =>
        kernel.auditNow(kernel.userActor(context), action, 'incident', entityId, correlationId),
      reader,
    }),
    reader,
    scanner: new IncidentSlaScanner(incidents, store, settings, options),
    delivery: new IncidentAlertDelivery(
      incidents,
      store,
      alertMembers(kernel, adapters),
      adapters.incidentAlertAddresses ?? syntheticAddresses,
      mailer,
      options,
    ),
    store,
    mailer,
    enqueueScan: (tenantId, incidentId) =>
      store.enqueueScan({
        tenantId,
        jobId: randomUUID(),
        ...(incidentId === undefined ? {} : { incidentId }),
        at: kernel.now().toISOString(),
      }),
  };
}

/** The recorded messages of the test sink, when the module runs on it (tests only). */
export const sinkOf = (module: IncidentSlaModule): TestSinkMailer | null =>
  'messages' in module.mailer ? (module.mailer as TestSinkMailer) : null;
