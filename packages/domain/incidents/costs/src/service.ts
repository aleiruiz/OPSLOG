import {
  IncidentError,
  INCIDENT_COSTS_CHANGED_EVENT,
  TERMINAL_STATUSES,
  can,
  canonicalJson,
  payloadHash,
  type Incident,
  type IncidentActor,
  type IncidentStore,
} from '../../cases/src/index.js';
import {
  IncidentWriteBase,
  TwinWon,
  withoutApprovals,
  type WriteOptions,
} from '../../repairs/src/index.js';
import { parseCostsUpdate } from './input.js';
import { closedOrders, type CostLedger } from './ledger.js';
import type {
  ClosedOrder,
  CostLine,
  CostSnapshot,
  CurrencyTotals,
  IncidentCostStore,
  Money,
  PolicyDeductible,
  PolicyDeductibles,
} from './ports.js';
import { sumByCurrency } from './summary.js';

const UPDATE = 'costs_update';

export interface CostsView {
  /** The version of the case: what the next `PUT` sends. */
  readonly version: number;
  readonly lines: readonly CostLine[];
  readonly initialEstimate: Money | null;
  readonly repairs: readonly {
    readonly linkId: string;
    readonly orderId: string;
    /** Empty for a cancelled order: its costs do not count. */
    readonly totals: readonly Money[];
  }[];
  readonly totals: readonly CurrencyTotals[];
  readonly mixedCurrencies: boolean;
  readonly policyDeductible: PolicyDeductible | null;
  /** Set (and only then) when insurance could not be read: the reference is missing, the costs are not. */
  readonly policyDeductibleUnavailable?: true;
  readonly snapshots: readonly {
    readonly cycle: number;
    readonly closedAt: string;
    readonly totals: readonly CurrencyTotals[];
    readonly orders: readonly ClosedOrder[];
  }[];
  /** The linked orders or the totals are not what the last closure kept (an order was reopened, a cost changed). */
  readonly differsFromLastClosure: boolean;
}
export interface CostsResult {
  readonly incident: Incident;
  readonly costs: CostsView;
}

/** Costs of a case (FR-117, FR-118, BR-027): own lines, initial estimate and totals by currency. */
export class IncidentCostService extends IncidentWriteBase {
  public constructor(
    incidents: IncidentStore,
    private readonly costs: IncidentCostStore,
    private readonly ledger: CostLedger,
    private readonly deductibles: PolicyDeductibles,
    options: WriteOptions = {},
  ) {
    super(incidents, options);
  }

  /** Costs are financial data (D10): `incidents:view_costs` on top of the right to see the case. */
  private requireCosts(actor: IncidentActor): void {
    if (!can(actor, 'incidents:view_costs')) throw new IncidentError('forbidden');
  }

  private async build(tenantId: string, incident: Incident): Promise<CostsView> {
    const read = await this.ledger.read(tenantId, incident.id);
    const [estimate, snapshots] = await Promise.all([
      this.costs.estimate(tenantId, incident.id),
      this.costs.snapshots(tenantId, incident.id),
    ]);
    const snapshot = incident.policySnapshot;
    const last: CostSnapshot | undefined = snapshots[snapshots.length - 1];
    // The deductible is a reference beside the totals, from another module: its failure must not take
    // the costs (and their editing) down with it. The totals above never degrade to a guess.
    let deductible: PolicyDeductible | null = null;
    let unavailable = false;
    if (snapshot)
      try {
        deductible = await this.deductibles.deductible(
          tenantId,
          snapshot.policyId,
          snapshot.revision,
        );
      } catch {
        unavailable = true;
      }
    return {
      version: incident.version,
      lines: read.lines,
      initialEstimate: estimate,
      repairs: read.links.map(({ link, order }) => ({
        linkId: link.id,
        orderId: order.id,
        totals: order.status === 'cancelled' ? [] : sumByCurrency(order.costs),
      })),
      totals: read.totals,
      mixedCurrencies: read.totals.length > 1,
      policyDeductible: deductible,
      ...(unavailable ? { policyDeductibleUnavailable: true as const } : {}),
      snapshots: snapshots.map(({ cycle, closedAt, totals, orders }) => ({
        cycle,
        closedAt,
        totals,
        orders,
      })),
      differsFromLastClosure:
        last !== undefined &&
        canonicalJson({ totals: read.totals, orders: closedOrders(read) }) !==
          canonicalJson({ totals: last.totals, orders: last.orders }),
    };
  }

  public async get(tenantId: string, actor: IncidentActor, id: string): Promise<CostsResult> {
    const incident = await this.visible(tenantId, actor, id);
    this.requireCosts(actor);
    return { incident, costs: await this.build(tenantId, incident) };
  }

  public async update(
    tenantId: string,
    actor: IncidentActor,
    id: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<CostsResult> {
    const incident = await this.visible(tenantId, actor, id);
    this.requireEdit(actor);
    this.requireCosts(actor);
    const key = this.requiredKey(idempotencyKey);
    // A retry is recognised by its shape alone: the lines it names may have changed since it first ran.
    const keyed = {
      command: UPDATE,
      key,
      hash: payloadHash(incident.id, UPDATE, parseCostsUpdate(input, null)),
    };
    const replayed = async (stored: Incident): Promise<CostsResult> => ({
      incident: stored,
      costs: await this.build(tenantId, stored),
    });
    const twin = await this.replay(tenantId, actor, keyed);
    if (twin) return replayed(twin.response);
    const current = await this.costs.lines(tenantId, incident.id);
    const update = parseCostsUpdate(input, new Set(current.map((line) => line.id)));
    if (TERMINAL_STATUSES.includes(incident.status) || incident.status === 'draft')
      throw new IncidentError('invalid_transition');
    if (incident.version !== update.version) throw new IncidentError('stale_version');
    const lines: CostLine[] = update.lines.map((line) => ({
      id: line.id ?? this.newId(),
      kind: line.kind,
      category: line.category,
      amount: line.amount,
      note: line.note,
    }));
    const estimate =
      update.initialEstimate === undefined
        ? await this.costs.estimate(tenantId, incident.id)
        : update.initialEstimate;
    const before = await this.costs.estimate(tenantId, incident.id);
    const linesChanged = canonicalJson(lines) !== canonicalJson(current);
    const estimateChanged = canonicalJson(estimate) !== canonicalJson(before);
    if (!linesChanged && !estimateChanged) return replayed(incident);
    const { next, cleared } = withoutApprovals(incident);
    const time = this.now().toISOString();
    try {
      const written = await this.commit({
        tenantId,
        actor,
        incident,
        next,
        command: 'costs_changed',
        changed: [
          ...(linesChanged ? ['costLines'] : []),
          ...(estimateChanged ? ['initialEstimate'] : []),
          ...cleared,
        ],
        // Counts only: never an amount, a currency or a note.
        before: { lineCount: current.length, hadEstimate: before !== null },
        event: (stored) => ({
          type: INCIDENT_COSTS_CHANGED_EVENT,
          payload: { incidentId: stored.id, version: stored.version },
        }),
        write: (mutation) =>
          this.costs.apply(mutation, {
            tenantId,
            incidentId: incident.id,
            lines,
            estimate,
            actorId: actor.id,
            at: time,
          }),
        keyed,
      });
      return replayed(written);
    } catch (error) {
      if (error instanceof TwinWon) return replayed(error.record.response);
      throw error;
    }
  }
}
