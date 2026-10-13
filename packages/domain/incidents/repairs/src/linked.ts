import type { IncidentRepairs, RepairsSnapshot } from '../../workflow/src/index.js';
import type {
  IncidentRepairStore,
  RepairLink,
  RepairOrderReader,
  RepairOrderRef,
} from './ports.js';

/** An order that is linked but cannot be read is a broken invariant: it is an error (500), never a guess. */
export async function readLinkedOrders(
  links: readonly RepairLink[],
  reader: RepairOrderReader,
  tenantId: string,
): Promise<readonly { readonly link: RepairLink; readonly order: RepairOrderRef }[]> {
  return Promise.all(
    links.map(async (link) => {
      const order = await reader.order(tenantId, link.orderId);
      if (!order) throw new Error('A linked work order could not be read');
      return { link, order };
    }),
  );
}

/** The workflow's view of the linked orders: state, version and whether they carry costs, never an amount. */
export function orderFacts(
  rows: readonly { readonly order: RepairOrderRef }[],
): Extract<RepairsSnapshot, { available: true }> {
  return {
    available: true,
    orders: rows.map(({ order }) => ({
      orderId: order.id,
      status: order.status,
      version: order.version,
      hasCosts: order.costs.length > 0,
    })),
  };
}

/**
 * `IncidentRepairs` over the links and the order reader. It never answers `available: false`: a read
 * that fails throws, so a case with open linked orders can never look like one without orders.
 */
export class LinkedRepairs implements IncidentRepairs {
  public constructor(
    private readonly links: Pick<IncidentRepairStore, 'links'>,
    private readonly reader: RepairOrderReader,
  ) {}

  public async linkedOrders(
    tenantId: string,
    incidentId: string,
    tx?: unknown,
  ): Promise<RepairsSnapshot> {
    const links = await this.links.links(tenantId, incidentId, tx);
    return orderFacts(await readLinkedOrders(links, this.reader, tenantId));
  }
}
