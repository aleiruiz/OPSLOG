import type { Incident, NewIncidentTransition } from '../../cases/src/index.js';
import {
  ADMIN,
  MANAGER,
  TENANT_A,
  VIEWER,
  actorOf,
  draft,
  put,
  reload,
  setup as workflowSetup,
} from '../../workflow/src/test-support.js';
import type { SlaSettings } from './catalog.js';
import { IncidentAlertDelivery, type DeliveryOptions } from './delivery.js';
import type {
  AlertAddresses,
  AlertMembers,
  AlertMessage,
  IncidentAlertMailer,
  MemberProfile,
  SlaSettingsReader,
} from './ports.js';
import { IncidentSlaReader } from './reader.js';
import { IncidentSlaScanner } from './scan.js';
import { InMemoryIncidentSlaStore, type SlaEvent } from './store.js';

export { ADMIN, MANAGER, TENANT_A, VIEWER, actorOf, draft, put, reload };
export const TENANT_B = 'tenant-b';
export const MEXICO = 'America/Mexico_City';

/** The report instant of the acceptance cases: 2026-11-01 10:00 local in Mexico City (UTC-6). */
export const REPORTED_AT = '2026-11-01T16:00:00.000Z';
export const at = (base: string, ms: number): Date => new Date(Date.parse(base) + ms);
export const DAY = 86_400_000;
export const HOUR = 3_600_000;

export const DEFAULT_SETTINGS: SlaSettings = {
  timeZone: MEXICO,
  targetDays: { critical: 7, high: 15, medium: 30, low: 45 },
  inactivityDays: 5,
};

export class FakeSettings implements SlaSettingsReader {
  public readonly byTenant = new Map<string, SlaSettings>();
  public fail = false;
  public reads = 0;
  public async settings(tenantId: string): Promise<SlaSettings> {
    this.reads += 1;
    if (this.fail) throw new Error('settings unavailable');
    return this.byTenant.get(tenantId) ?? DEFAULT_SETTINGS;
  }
}

/** Active members by `tenant/actorId`; `holders` follows from their permissions. */
export class FakeMembers implements AlertMembers {
  public readonly profiles = new Map<string, MemberProfile>();
  public set(tenantId: string, actorId: string, permissions: readonly string[], linked = false) {
    this.profiles.set(`${tenantId}/${actorId}`, { permissions, mechanicLinked: linked });
  }
  public revoke(tenantId: string, actorId: string) {
    this.profiles.delete(`${tenantId}/${actorId}`);
  }
  public async profile(tenantId: string, actorId: string) {
    return this.profiles.get(`${tenantId}/${actorId}`) ?? null;
  }
  public async holders(tenantId: string, permission: 'incidents:edit' | 'incidents:approve') {
    return [...this.profiles]
      .filter(([key, p]) => key.startsWith(`${tenantId}/`) && p.permissions.includes(permission))
      .map(([key]) => key.slice(tenantId.length + 1));
  }
}

export class FakeAddresses implements AlertAddresses {
  public readonly missing = new Set<string>();
  public async addressOf(tenantId: string, actorId: string) {
    return this.missing.has(actorId) ? null : `${actorId}@${tenantId}.example.test`;
  }
}

/** The test sink: keeps the messages in memory and can be told to fail the next sends. */
export class RecordingMailer implements IncidentAlertMailer {
  public readonly sent: AlertMessage[] = [];
  public failNext = 0;
  public attempts = 0;
  public async send(message: AlertMessage): Promise<void> {
    this.attempts += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('mail port down');
    }
    this.sent.push(message);
  }
}

/** The workflow world plus the SLA over the in-memory store, a mutable clock and the fakes above. */
export function slaWorld(start: Date = at(REPORTED_AT, 0)) {
  const clock = { current: start };
  const now = () => clock.current;
  const world = workflowSetup(now);
  const events: SlaEvent[] = [];
  const flags = { failEmit: false };
  const store = new InMemoryIncidentSlaStore(world.store, (event) => {
    if (flags.failEmit) throw new Error('outbox down');
    events.push(event);
  });
  const settings = new FakeSettings();
  const members = new FakeMembers();
  const addresses = new FakeAddresses();
  const mailer = new RecordingMailer();
  const scanner = new IncidentSlaScanner(world.store, store, settings, { now });
  const reader = new IncidentSlaReader(world.store, store, settings, { now });
  const delivery = (options: DeliveryOptions = {}) =>
    new IncidentAlertDelivery(world.store, store, members, addresses, mailer, { now, ...options });
  members.set(TENANT_A, MANAGER.id, ['incidents:view', 'incidents:edit']);
  members.set(TENANT_A, ADMIN.id, ['incidents:view', 'incidents:edit', 'incidents:approve']);
  members.set(TENANT_A, VIEWER.id, ['incidents:view']);
  return {
    ...world,
    clock,
    flags,
    events,
    slaStore: store,
    slaSettings: settings,
    directory: members,
    addresses,
    mailer,
    scanner,
    reader,
    delivery,
  };
}
export type SlaWorld = ReturnType<typeof slaWorld>;

export const reportEntry = (occurredAt: string): NewIncidentTransition => ({
  command: 'report',
  from: 'draft',
  to: 'reported',
  actorId: MANAGER.id,
  comment: null,
  occurredAt,
  changedFields: ['reportedAt', 'status'],
  before: null,
});
export const entry = (command: string, occurredAt: string): NewIncidentTransition => ({
  command,
  from: null,
  to: 'reported',
  actorId: MANAGER.id,
  comment: null,
  occurredAt,
  changedFields: [],
  before: null,
});

/** A case of tenant A reported at `reportedAt` (synthetic fixture write, as a command would leave it). */
export async function reportedCase(
  world: SlaWorld,
  patch: Partial<Incident> = {},
  reportedAt = REPORTED_AT,
): Promise<Incident> {
  const created = await draft(world, { severity: 'high' });
  return put(
    world,
    created,
    { status: 'reported', reportedAt, updatedAt: reportedAt, severity: 'high', ...patch },
    [reportEntry(reportedAt)],
  );
}
