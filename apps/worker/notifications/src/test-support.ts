import type { Permission } from '../../../../packages/domain/identity/src/index.js';
import { harness } from '../../../../packages/domain/notifications/src/test-support.js';
import type {
  ExpiryItem,
  IncidentFacts,
  NotificationSources,
  OrderFacts,
  SlaNoticeFacts,
} from './ports.js';

const key = (tenantId: string, id: string) => `${tenantId}|${id}`;

/** Facts the tests set; a record that was not set is "not found". */
export class FakeSources implements NotificationSources {
  public readonly incidents = new Map<string, IncidentFacts>();
  public readonly orders = new Map<string, OrderFacts>();
  public readonly plans = new Map<string, string>();
  public readonly vehicles = new Map<string, string>();
  public readonly exportJobs = new Map<string, { requesterId: string; reportTitle: string }>();
  public readonly sla = new Map<string, SlaNoticeFacts>();
  public readonly due = new Map<string, ExpiryItem[]>();
  public readonly holdersOf = new Map<string, string[]>();
  public async incident(t: string, id: string) {
    return this.incidents.get(key(t, id)) ?? null;
  }
  public async order(t: string, id: string) {
    return this.orders.get(key(t, id)) ?? null;
  }
  public async planVehicle(t: string, id: string) {
    return this.plans.get(key(t, id)) ?? null;
  }
  public async vehicleLabel(t: string, id: string) {
    return this.vehicles.get(key(t, id)) ?? null;
  }
  public async exportJob(t: string, id: string) {
    return this.exportJobs.get(key(t, id)) ?? null;
  }
  public async holders(t: string, permission: Permission) {
    return this.holdersOf.get(key(t, permission)) ?? [];
  }
  public async slaNotice(t: string, id: string) {
    return this.sla.get(key(t, id)) ?? null;
  }
  public async expiring(t: string) {
    return this.due.get(t) ?? [];
  }
  public async timeZone() {
    return 'America/Mexico_City';
  }
}

export function setup() {
  const h = harness();
  const sources = new FakeSources();
  sources.vehicles.set('A|v1', 'ECO-1');
  sources.holdersOf.set('A|edit', ['ana', 'luis']);
  sources.holdersOf.set('A|approve', ['root']);
  sources.holdersOf.set('A|manage_users', ['root']);
  const deps = { ingest: h.ingest, sources, now: h.now };
  return { h, sources, deps };
}
