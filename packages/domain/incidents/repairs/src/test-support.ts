import { type Incident } from '../../cases/src/index.js';
import {
  ADMIN,
  MANAGER,
  NOW,
  TENANT_A,
  VIEWER,
  VEHICLE,
  actorOf,
  draft,
  put,
  reload,
  setup as workflowSetup,
} from '../../workflow/src/test-support.js';
import { LinkedRepairs } from './linked.js';
import { RepairLinkService } from './links.js';
import type { RepairOrderReader, RepairOrderRef } from './ports.js';
import { InMemoryIncidentRepairStore } from './store.js';

export { ADMIN, MANAGER, NOW, TENANT_A, VIEWER, VEHICLE, actorOf, draft, put, reload };
export const TENANT_B = 'tenant-b';

/** The workshop's orders, keyed by tenant so a foreign id reads as absent. */
export class FakeOrders implements RepairOrderReader {
  public readonly orders = new Map<string, RepairOrderRef>();
  public fail = false;
  public reads = 0;
  /** While set, reads wait for it: lets a test hold two commands at the same point. */
  public hold: Promise<void> | null = null;
  public add(id: string, over: Partial<RepairOrderRef> = {}, tenantId = TENANT_A): RepairOrderRef {
    const order: RepairOrderRef = {
      id,
      vehicleId: VEHICLE,
      kind: 'corrective',
      status: 'in_progress',
      version: 3,
      description: 'Reparación sintética',
      workshopName: 'Taller Sintético',
      costs: [],
      ...over,
    };
    this.orders.set(`${tenantId}/${id}`, order);
    return order;
  }
  public async order(tenantId: string, orderId: string): Promise<RepairOrderRef | null> {
    this.reads += 1;
    if (this.hold) await this.hold;
    if (this.fail) throw new Error('orders unavailable');
    return this.orders.get(`${tenantId}/${orderId}`) ?? null;
  }
}

/** The workflow world plus the links of INC-COSTS over the in-memory store. */
export function setup(now: () => Date = () => NOW) {
  const world = workflowSetup(now);
  const links = new InMemoryIncidentRepairStore(world.store);
  const orders = new FakeOrders();
  let n = 0;
  const options = { now, newId: () => `id-${++n}` };
  const service = new RepairLinkService(world.store, links, orders, world.evidence, options);
  return {
    ...world,
    links,
    orders,
    options,
    service,
    repairs: new LinkedRepairs(links, orders),
  };
}
export type World = ReturnType<typeof setup>;

/** A case of tenant A taken straight to the given state, owned by the manager. */
export async function caseIn(
  world: Pick<World, 'cases' | 'store'>,
  status: Incident['status'],
  patch: Partial<Incident> = {},
): Promise<Incident> {
  const created = await world.cases.create(TENANT_A, MANAGER, {
    vehicleId: VEHICLE,
    type: 'collision',
  });
  return put(world as never, created, { status, ...patch });
}
