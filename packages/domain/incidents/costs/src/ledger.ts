import type {
  ApprovalCostsRequest,
  ClosureCostsRequest,
  CostPresence,
  CostTotals,
  IncidentClosureCosts,
  IncidentCostPresence,
  IncidentCostTotals,
} from '../../workflow/src/index.js';
import {
  readLinkedOrders,
  type IncidentRepairStore,
  type RepairLink,
  type RepairOrderReader,
  type RepairOrderRef,
} from '../../repairs/src/index.js';
import type { ClosedOrder, CostLine, CurrencyTotals, IncidentCostStore } from './ports.js';
import { summarize } from './summary.js';

export interface LedgerRead {
  readonly lines: readonly CostLine[];
  readonly links: readonly { readonly link: RepairLink; readonly order: RepairOrderRef }[];
  /** A cancelled order is no repair: its costs do not count and it is not part of a snapshot. */
  readonly counted: readonly { readonly link: RepairLink; readonly order: RepairOrderRef }[];
  readonly totals: readonly CurrencyTotals[];
}

export const closedOrders = (read: Pick<LedgerRead, 'counted'>): readonly ClosedOrder[] =>
  read.counted
    .map(({ order }) => ({ orderId: order.id, version: order.version, status: order.status }))
    .sort((a, b) => (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0));

/**
 * The costs of a case as the workflow ports need them. Reads join the transaction of the command
 * (`tx`) for the case's own rows; the orders come through `RepairOrderReader`, which belongs to the
 * workshop module and cannot join it. Every read that fails throws: a missing cost is never zero.
 */
export class CostLedger implements IncidentCostPresence, IncidentCostTotals, IncidentClosureCosts {
  public constructor(
    private readonly costs: IncidentCostStore,
    private readonly links: Pick<IncidentRepairStore, 'links'>,
    private readonly orders: RepairOrderReader,
  ) {}

  public async read(tenantId: string, incidentId: string, tx?: unknown): Promise<LedgerRead> {
    const lines = await this.costs.lines(tenantId, incidentId, tx);
    const links = await readLinkedOrders(
      await this.links.links(tenantId, incidentId, tx),
      this.orders,
      tenantId,
    );
    const counted = links.filter(({ order }) => order.status !== 'cancelled');
    return {
      lines,
      links,
      counted,
      totals: summarize(
        lines,
        counted.flatMap(({ order }) => order.costs),
      ),
    };
  }

  public async presence(tenantId: string, incidentId: string): Promise<CostPresence> {
    const [lines, links] = await Promise.all([
      this.costs.lines(tenantId, incidentId),
      this.links.links(tenantId, incidentId),
    ]);
    return {
      available: true,
      hasCosts: lines.length > 0 || links.length > 0,
      hasRepairLine: lines.some((line) => line.kind === 'expense' && line.category === 'repair'),
    };
  }

  public async totals(tenantId: string, incidentId: string, tx?: unknown): Promise<CostTotals> {
    const { totals } = await this.read(tenantId, incidentId, tx);
    return {
      available: true,
      companyBorne: totals.map(({ currency, companyBorne }) => ({
        currency,
        amountMinor: companyBorne,
      })),
    };
  }

  public async recordApproval(request: ApprovalCostsRequest, tx: unknown): Promise<void> {
    const { totals } = await this.read(request.tenantId, request.incidentId, tx);
    await this.costs.saveApproval(
      request.tenantId,
      request.incidentId,
      request.kind,
      totals.map(({ currency, companyBorne }) => ({ currency, amountMinor: companyBorne })),
      tx,
    );
  }

  public async approvalStale(request: ApprovalCostsRequest, tx?: unknown): Promise<boolean> {
    const approved = await this.costs.approval(
      request.tenantId,
      request.incidentId,
      request.kind,
      tx,
    );
    // Nothing recorded: the approval cannot be shown to cover the costs.
    if (approved === null) return true;
    const { totals } = await this.read(request.tenantId, request.incidentId, tx);
    return totals.some(({ currency, companyBorne }) => {
      const covered = approved.find((money) => money.currency === currency);
      return BigInt(companyBorne) > BigInt(covered?.amountMinor ?? '0');
    });
  }

  public async snapshot(request: ClosureCostsRequest, tx: unknown): Promise<void> {
    const read = await this.read(request.tenantId, request.incidentId, tx);
    await this.costs.saveSnapshot(
      {
        tenantId: request.tenantId,
        incidentId: request.incidentId,
        cycle: request.cycle,
        closedAt: request.closedAt,
        totals: read.totals,
        orders: closedOrders(read),
      },
      tx,
    );
  }
}
