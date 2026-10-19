import { createHash } from 'node:crypto';
import type { Handler } from '../../base/src/index.js';
import {
  exportTitle,
  incidentCreatedTitle,
  incidentStatusTitle,
  maintenanceTitle,
  membershipTitle,
  outOfServiceTitle,
  titled,
  workOrderTitle,
  dayIn,
  type NotificationEvent,
  type NotificationIngest,
  type Severity,
} from '../../../../packages/domain/notifications/src/index.js';
import type { NotificationSources } from './ports.js';

export const EVENTS = {
  incidentCreated: 'incident.created',
  incidentStatus: 'incident.status_changed',
  slaAlert: 'incident.sla_alert',
  planAlert: 'maintenance.plan.alert',
  orderStatus: 'maintenance.status_changed',
  vehicleStatus: 'vehicle.status_changed',
  exportDone: 'export.completed',
  exportFailed: 'export.failed',
  membershipCreated: 'membership.created',
  membershipRole: 'membership.role_changed',
} as const;

export interface HandlerDeps {
  readonly ingest: Pick<NotificationIngest, 'ingest'>;
  readonly sources: NotificationSources;
  readonly now: () => Date;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** The payload of an event, read as strictly as its producer wrote it; anything else is refused and retried. */
function fields(payload: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    throw new Error('invalid notification event');
  const record = payload as Record<string, unknown>;
  const allowed = [...required, ...optional];
  if (
    Object.keys(record).some((key) => !allowed.includes(key)) ||
    required.some((key) => record[key] === undefined)
  )
    throw new Error('invalid notification event');
  return record;
}
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('invalid notification event');
  return value;
};
const count = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new Error('invalid notification event');
  return value;
};
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 12);
const unique = (...lists: readonly (readonly (string | null)[])[]): string[] => [
  ...new Set(lists.flat().filter((item): item is string => item !== null)),
];

type Builder = (
  deps: HandlerDeps,
  tenantId: string,
  payload: unknown,
) => Promise<NotificationEvent | null>;

const incidentEvent =
  (kind: 'incident_created' | 'incident_status_changed'): Builder =>
  async ({ sources }, tenantId, payload) => {
    const data =
      kind === 'incident_created'
        ? fields(payload, ['incidentId', 'vehicleId', 'version'])
        : fields(payload, ['incidentId', 'vehicleId', 'version', 'status']);
    const incidentId = id(data['incidentId']);
    const version = count(data['version']);
    const facts = await sources.incident(tenantId, incidentId);
    if (!facts) return null;
    const status = kind === 'incident_status_changed' ? String(data['status']) : 'created';
    const closed = status === 'closed' || status === 'cancelled';
    return {
      tenantId,
      kind,
      entityType: 'incident',
      entityId: incidentId,
      title:
        kind === 'incident_created'
          ? incidentCreatedTitle(facts.folio)
          : incidentStatusTitle(status, facts.folio),
      link: `/incidents/${incidentId}`,
      severity: closed ? 'info' : 'attention',
      dateVersion: kind === 'incident_created' ? 'created' : `v${version}`,
      threshold: status,
      recipients: unique([facts.responsibleId, facts.createdBy]),
    };
  };

const planAlert: Builder = async ({ sources, now }, tenantId, payload) => {
  const data = fields(
    payload,
    ['alertId', 'planId', 'eventType', 'schemaVersion'],
    ['occurrenceId'],
  );
  const planId = id(data['planId']);
  const type = String(data['eventType']);
  if (type !== 'upcoming' && type !== 'due' && type !== 'overdue')
    throw new Error('invalid notification event');
  const vehicleId = await sources.planVehicle(tenantId, planId);
  const label = vehicleId ? ((await sources.vehicleLabel(tenantId, vehicleId)) ?? '') : '';
  const overdue = type === 'overdue';
  const [fleet, supervisors] = await Promise.all([
    sources.holders(tenantId, 'edit'),
    overdue ? sources.holders(tenantId, 'approve') : Promise.resolve([]),
  ]);
  return {
    tenantId,
    kind: overdue ? 'maintenance_overdue' : 'maintenance_upcoming',
    entityType: 'maintenance_plan',
    entityId: planId,
    title: maintenanceTitle(overdue, label),
    link: '/flota/mantenimiento',
    severity: overdue ? 'important' : 'attention',
    // At most one overdue notice a day; an upcoming one per alert of the scan.
    dateVersion: overdue
      ? dayIn(now(), await sources.timeZone(tenantId))
      : `a${digest(id(data['alertId']))}`,
    threshold: overdue ? 'overdue' : 'upcoming',
    recipients: unique(fleet, supervisors),
  };
};

const orderStatus: Builder = async ({ sources }, tenantId, payload) => {
  const data = fields(payload, ['orderId', 'vehicleId', 'version']);
  const orderId = id(data['orderId']);
  const order = await sources.order(tenantId, orderId);
  // Only the assignment is a notice; the rest of the order's states are not.
  if (!order || order.status !== 'assigned' || order.mechanicMemberId === null) return null;
  const label = (await sources.vehicleLabel(tenantId, order.vehicleId)) ?? '';
  return {
    tenantId,
    kind: 'work_order_assigned',
    entityType: 'work_order',
    entityId: orderId,
    title: workOrderTitle(label),
    link: `/flota/mantenimiento/ordenes/${orderId}`,
    severity: 'important',
    dateVersion: `v${count(data['version'])}`,
    threshold: 'assigned',
    recipients: [order.mechanicMemberId],
  };
};

const vehicleStatus: Builder = async ({ sources }, tenantId, payload) => {
  const data = fields(payload, ['vehicleId', 'status', 'version']);
  if (data['status'] !== 'out_of_service') return null;
  const vehicleId = id(data['vehicleId']);
  const label = (await sources.vehicleLabel(tenantId, vehicleId)) ?? '';
  return {
    tenantId,
    kind: 'vehicle_out_of_service',
    entityType: 'vehicle',
    entityId: vehicleId,
    title: outOfServiceTitle(label),
    link: `/flota/vehiculos/${vehicleId}`,
    severity: 'important',
    dateVersion: `v${count(data['version'])}`,
    threshold: 'out_of_service',
    recipients: await sources.holders(tenantId, 'edit'),
  };
};

const exportEvent =
  (ready: boolean): Builder =>
  async ({ sources }, tenantId, payload) => {
    const data = ready
      ? fields(payload, ['jobId', 'reportId', 'format', 'rowCount'])
      : fields(payload, ['jobId', 'reportId', 'format', 'code']);
    const jobId = id(data['jobId']);
    const job = await sources.exportJob(tenantId, jobId);
    if (!job) return null;
    return {
      tenantId,
      kind: ready ? 'export_ready' : 'export_failed',
      entityType: 'export',
      entityId: jobId,
      title: exportTitle(ready, job.reportTitle),
      link: '/analisis/reportes',
      severity: ready ? 'info' : 'attention',
      dateVersion: 'done',
      threshold: ready ? 'ready' : 'failed',
      recipients: [job.requesterId],
    };
  };

const membership =
  (created: boolean): Builder =>
  async ({ sources }, tenantId, payload) => {
    const data = fields(payload, ['memberId', 'role', 'version']);
    const memberId = id(data['memberId']);
    return {
      tenantId,
      kind: created ? 'membership_created' : 'membership_role_changed',
      entityType: 'member',
      entityId: memberId,
      title: membershipTitle(created),
      link: '/configuracion/usuarios',
      severity: 'info',
      dateVersion: `v${count(data['version'])}`,
      threshold: created ? 'created' : id(data['role']),
      recipients: unique([memberId], await sources.holders(tenantId, 'manage_users')),
    };
  };

const BUILDERS: Readonly<Record<string, Builder>> = {
  [EVENTS.incidentCreated]: incidentEvent('incident_created'),
  [EVENTS.incidentStatus]: incidentEvent('incident_status_changed'),
  [EVENTS.planAlert]: planAlert,
  [EVENTS.orderStatus]: orderStatus,
  [EVENTS.vehicleStatus]: vehicleStatus,
  [EVENTS.exportDone]: exportEvent(true),
  [EVENTS.exportFailed]: exportEvent(false),
  [EVENTS.membershipCreated]: membership(true),
  [EVENTS.membershipRole]: membership(false),
};

/**
 * One handler per outbox event the center listens to. The company always comes from the claimed
 * envelope; a payload that is not exactly what its producer writes is refused and the outbox retries
 * it. A fact that cannot be read (the record is gone) is dropped: there is nobody to tell.
 */
export function notificationHandlers(deps: HandlerDeps): Readonly<Record<string, Handler>> {
  return Object.fromEntries(
    Object.entries(BUILDERS).map(([type, build]): [string, Handler] => [
      type,
      async (payload, event) => {
        const notice = await build(deps, event.tenantId, payload);
        if (notice) await deps.ingest.ingest(notice);
      },
    ]),
  );
}

/**
 * The in-app notice of an INC-SLA alert. It runs next to INC-SLA's own handler, which keeps sending
 * the e-mail; an error here is thrown after that handler ran, so a failed notice is retried without
 * ever holding back the e-mail.
 */
export function slaNoticeHandler(deps: HandlerDeps): Handler {
  return async (payload, event) => {
    const data = fields(payload, ['incidentId', 'alertId', 'kind', 'cycle']);
    const facts = await deps.sources.slaNotice(event.tenantId, id(data['alertId']));
    if (!facts || facts.incidentId !== id(data['incidentId'])) return;
    const severity: Severity = facts.severity;
    await deps.ingest.ingest({
      tenantId: event.tenantId,
      kind: 'incident_sla',
      entityType: 'incident',
      entityId: facts.incidentId,
      title: titled(facts.label, facts.folio),
      link: `/incidents/${facts.incidentId}`,
      severity,
      dateVersion: `a${digest(id(data['alertId']))}`,
      threshold: id(data['kind']).slice(0, 39),
      recipients: facts.recipients,
    });
  };
}
