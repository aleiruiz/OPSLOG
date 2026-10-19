import {
  MAX_ALERT_OFFSET,
  type AlertService,
} from '../../../../../packages/domain/alerts/src/index.js';
import type { Permission } from '../../../../../packages/domain/identity/src/index.js';
import {
  TERMINAL_STATUSES,
  type IncidentStore,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import {
  KIND_LABELS,
  recipientsOf,
  type AlertMembers,
  type IncidentSlaStore,
} from '../../../../../packages/domain/incidents/sla/src/index.js';
import type { MechanicStore } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import type { WorkOrderStore } from '../../../../../packages/domain/maintenance/orders/src/index.js';
import type { PlanStore } from '../../../../../packages/domain/maintenance/plans/src/index.js';
import {
  meets,
  type EntityVisibility,
  type MemberAccess,
  type RecipientDirectory,
} from '../../../../../packages/domain/notifications/src/index.js';
import type { VehicleStore } from '../../../../../packages/domain/vehicles/src/index.js';
import type { AlertAddresses } from '../../../../../packages/domain/incidents/sla/src/index.js';
import type {
  ExpiryItem,
  NotificationSources,
} from '../../../../worker/notifications/src/index.js';
import { ROLE_PERMISSIONS } from '../access.js';
import type { PlatformKernel } from './kernel.js';
import { createMechanicScope } from './mechanic-scope.js';

const PREFIX = /^user-/;
/** Incidents keep people as `user-<subject>`; the center and the identity directory use the bare subject. */
export const subjectOf = (actorId: string): string => actorId.replace(PREFIX, '');

export interface NotificationReaders {
  readonly vehicles: VehicleStore;
  readonly incidents: IncidentStore;
  readonly orders: WorkOrderStore;
  readonly plans: PlanStore;
  readonly mechanics: MechanicStore;
  readonly sla: { readonly store: IncidentSlaStore; readonly members: AlertMembers };
  readonly exportJobs: {
    find(
      tenantId: string,
      id: string,
    ): Promise<{ readonly actorId: string; readonly reportId: string } | null>;
  };
  readonly reportTitle: (reportId: string) => string | undefined;
  readonly alerts: AlertService;
  readonly settings: { get(tenantId: string): Promise<{ readonly timeZone: string }> };
  readonly addresses: AlertAddresses;
}

/** Members as the control plane knows them now: role, mechanic link, address and company. */
export function notificationDirectory(
  kernel: PlatformKernel,
  readers: Pick<NotificationReaders, 'mechanics' | 'addresses' | 'settings'>,
): RecipientDirectory {
  const scope = createMechanicScope(readers.mechanics);
  return {
    access: async (tenantId, recipientId): Promise<MemberAccess | null> => {
      const role = await kernel.access.effectiveRole(tenantId, recipientId);
      if (!role || kernel.tenants.status(tenantId) !== 'active') return null;
      return {
        permissions: ROLE_PERMISSIONS[role],
        mechanicLinked: await scope.mechanicLinked(tenantId, recipientId),
      };
    },
    address: (tenantId, recipientId) =>
      readers.addresses.addressOf(tenantId, `user-${recipientId}`),
    company: async (tenantId) => ({
      name: kernel.tenantName(tenantId),
      timeZone: (await readers.settings.get(tenantId)).timeZone,
    }),
  };
}

/** A follower keeps receiving notices only while their right and the record both stand. */
export function notificationVisibility(
  readers: Pick<NotificationReaders, 'vehicles' | 'incidents'>,
): EntityVisibility {
  return {
    visible: async (tenantId, access, type, id) => {
      if (type === 'vehicle')
        return (
          meets(access, 'view') && (await readers.vehicles.find(tenantId, id))?.archivedAt === null
        );
      if (type === 'incident')
        return meets(access, 'incidents') && (await readers.incidents.get(tenantId, id)) !== null;
      return true;
    },
  };
}

/** What the outbox handlers and the expiry scan read, over the modules' own ports. */
export function notificationSources(
  kernel: PlatformKernel,
  readers: NotificationReaders,
): NotificationSources {
  return {
    incident: async (tenantId, id) => {
      const found = await readers.incidents.get(tenantId, id);
      return found
        ? {
            folio: found.folio,
            responsibleId: found.responsibleId === null ? null : subjectOf(found.responsibleId),
            createdBy: found.createdBy === null ? null : subjectOf(found.createdBy),
          }
        : null;
    },
    order: async (tenantId, id) => {
      const order = await readers.orders.get(tenantId, id);
      if (!order) return null;
      const mechanic =
        order.mechanicId === null ? null : await readers.mechanics.get(tenantId, order.mechanicId);
      return {
        vehicleId: order.vehicleId,
        status: order.status,
        mechanicMemberId: mechanic?.memberId == null ? null : subjectOf(mechanic.memberId),
      };
    },
    planVehicle: async (tenantId, id) => (await readers.plans.get(tenantId, id))?.vehicleId ?? null,
    vehicleLabel: async (tenantId, id) =>
      (await readers.vehicles.find(tenantId, id))?.economicNumber ?? null,
    exportJob: async (tenantId, id) => {
      const job = await readers.exportJobs.find(tenantId, id);
      return job
        ? { requesterId: job.actorId, reportTitle: readers.reportTitle(job.reportId) ?? 'Reporte' }
        : null;
    },
    holders: async (tenantId, permission: Permission) => {
      const found: string[] = [];
      for (const member of kernel.access.membersOf(tenantId)) {
        if (member.status !== 'active') continue;
        const role = await kernel.access.effectiveRole(tenantId, member.identityId);
        if (role && ROLE_PERMISSIONS[role].includes(permission)) found.push(member.identityId);
      }
      return found;
    },
    slaNotice: async (tenantId, alertId) => {
      const alert = await readers.sla.store.alert(tenantId, alertId);
      if (!alert) return null;
      const incident = await readers.incidents.get(tenantId, alert.incidentId);
      // A closed or cancelled case has nobody left to tell (INC-SLA skips it too).
      const open = incident !== null && !TERMINAL_STATUSES.includes(incident.status);
      const recipients = open
        ? await recipientsOf(alert, incident.responsibleId, readers.sla.members)
        : [];
      const kind = alert.kind;
      return {
        incidentId: alert.incidentId,
        folio: alert.folio,
        label: KIND_LABELS[kind],
        severity:
          kind === 'assigned'
            ? 'important'
            : kind.endsWith('breach') || kind.endsWith('escalation')
              ? 'critical'
              : 'attention',
        recipients: recipients.map(subjectOf),
      };
    },
    expiring: async (tenantId) => {
      const found: ExpiryItem[] = [];
      for (let offset = 0; offset <= MAX_ALERT_OFFSET; offset += 100) {
        const page = await readers.alerts.list(tenantId, { limit: 100, offset });
        for (const alert of page.items)
          found.push({
            source: alert.source,
            subjectId: alert.subjectId,
            vehicleId: alert.vehicleId,
            dueOn: alert.dueOn,
            daysToExpiry: alert.daysToExpiry,
          });
        if (offset + 100 >= page.total) break;
      }
      return found;
    },
    timeZone: async (tenantId) => (await readers.settings.get(tenantId)).timeZone,
  };
}
