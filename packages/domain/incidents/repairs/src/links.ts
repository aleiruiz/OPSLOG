import {
  IncidentError,
  INCIDENT_REPAIR_LINKED_EVENT,
  INCIDENT_REPAIR_UNLINKED_EVENT,
  TERMINAL_STATUSES,
  payloadHash,
  type Incident,
  type IncidentActor,
  type IncidentStatus,
  type IncidentStore,
} from '../../cases/src/index.js';
import { opaqueId } from '../../cases/src/validation.js';
import { repairOrderOrBudget, type IncidentEvidenceFacts } from '../../workflow/src/index.js';
import {
  IncidentWriteBase,
  TwinWon,
  keyedId,
  withoutApprovals,
  type KeyedCommand,
  type WriteOptions,
} from './base.js';
import { parseLink, parseUnlink } from './input.js';
import { orderFacts, readLinkedOrders } from './linked.js';
import type {
  IncidentRepairStore,
  RepairLink,
  RepairOrderReader,
  RepairOrderRef,
} from './ports.js';

/** Where an order may be linked or unlinked (INC-COSTS invariant 3); `draft` and `resolved` are out. */
export const LINK_STATES: readonly IncidentStatus[] = [
  'under_review',
  'insurance_process',
  'insurance_rejected',
  'no_insurance',
  'repair',
  'reopened',
];

export const REPAIR_RULES = {
  invalidAssociation: 'invalid_association',
  notCorrective: 'order_not_corrective',
  cancelled: 'order_cancelled',
} as const;

const LINK = 'repair_link';
const UNLINK = 'repair_unlink';

/** A link as the screens read it: the order's state and workshop name, never an amount or an id as a label. */
export interface RepairLinkView {
  readonly id: string;
  readonly orderId: string;
  readonly linkedAt: string;
  /** `user-<uuid>`. */
  readonly linkedBy: string;
  readonly order: {
    readonly id: string;
    readonly description: string | null;
    readonly status: RepairOrderRef['status'];
    readonly workshop: string | null;
  };
}
export interface RepairLinkResult {
  readonly incident: Incident;
  readonly link: RepairLinkView;
}

/** Corrective orders of the workshop linked to a case (FR-102); the order stays the workshop's. */
export class RepairLinkService extends IncidentWriteBase {
  public constructor(
    incidents: IncidentStore,
    private readonly links: IncidentRepairStore,
    private readonly orders: RepairOrderReader,
    private readonly evidence: IncidentEvidenceFacts,
    options: WriteOptions = {},
  ) {
    super(incidents, options);
  }

  private async view(tenantId: string, link: RepairLink): Promise<RepairLinkView> {
    const order = (await readLinkedOrders([link], this.orders, tenantId))[0]
      ?.order as RepairOrderRef;
    return {
      id: link.id,
      orderId: link.orderId,
      linkedAt: link.linkedAt,
      linkedBy: link.linkedBy,
      order: {
        id: order.id,
        description: order.description,
        status: order.status,
        workshop: order.workshopName,
      },
    };
  }

  public async list(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
  ): Promise<readonly RepairLinkView[]> {
    const incident = await this.visible(tenantId, actor, incidentId);
    const links = await this.links.links(tenantId, incident.id);
    return Promise.all(links.map((link) => this.view(tenantId, link)));
  }

  /** Terminal and out-of-list states answer 409 first, then a stale version. */
  private assertLinkable(incident: Incident, version: number): void {
    if (TERMINAL_STATUSES.includes(incident.status) || !LINK_STATES.includes(incident.status))
      throw new IncidentError('invalid_transition');
    if (incident.version !== version) throw new IncidentError('stale_version');
  }

  private keyed(incident: Incident, command: string, key: string, payload: unknown): KeyedCommand {
    return { command, key, hash: payloadHash(incident.id, command, payload) };
  }

  public async link(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<RepairLinkResult> {
    const incident = await this.visible(tenantId, actor, incidentId);
    this.requireEdit(actor);
    const key = this.requiredKey(idempotencyKey);
    const { version, orderId } = parseLink(input);
    const keyed = this.keyed(incident, LINK, key, { version, orderId });
    const replayed = async (stored: Incident): Promise<RepairLinkResult> => {
      const id = keyedId(tenantId, actor.id, LINK, key);
      const found = (await this.links.links(tenantId, incident.id)).find((row) => row.id === id);
      if (!found) throw new IncidentError('duplicate');
      return { incident: stored, link: await this.view(tenantId, found) };
    };
    const twin = await this.replay(tenantId, actor, keyed);
    if (twin) return replayed(twin.response);
    this.assertLinkable(incident, version);
    const order = await this.orders.order(tenantId, orderId);
    if (!order) throw new IncidentError('not_found');
    if (order.vehicleId !== incident.vehicleId)
      throw new IncidentError('rule_violation', [], REPAIR_RULES.invalidAssociation);
    if (order.kind !== 'corrective')
      throw new IncidentError('rule_violation', [], REPAIR_RULES.notCorrective);
    if (order.status === 'cancelled')
      throw new IncidentError('rule_violation', [], REPAIR_RULES.cancelled);
    if (await this.links.linkOfOrder(tenantId, orderId)) throw new IncidentError('duplicate');
    const link: RepairLink = {
      id: keyedId(tenantId, actor.id, LINK, key),
      tenantId,
      incidentId: incident.id,
      orderId,
      linkedAt: this.now().toISOString(),
      linkedBy: actor.id,
    };
    const { next, cleared } = withoutApprovals(incident);
    try {
      const written = await this.commit({
        tenantId,
        actor,
        incident,
        next,
        command: 'repair_linked',
        changed: ['repairLinks', ...cleared],
        before: { orderId },
        event: (stored) => ({
          type: INCIDENT_REPAIR_LINKED_EVENT,
          payload: { incidentId: stored.id, orderId, version: stored.version },
        }),
        write: (mutation) => this.links.apply(mutation, { kind: 'link', link }),
        keyed,
      });
      return { incident: written, link: await this.view(tenantId, link) };
    } catch (error) {
      if (error instanceof TwinWon) return replayed(error.record.response);
      throw error;
    }
  }

  /** In `repair`, the last order may leave only while a clean budget stands for "an order or a budget" (ADR-0014). */
  private async mustKeepRequirement(
    tenantId: string,
    incident: Incident,
    link: RepairLink,
  ): Promise<boolean> {
    const evidence = await this.evidence.evidence(tenantId, incident.id);
    const rows = await readLinkedOrders(
      await this.links.links(tenantId, incident.id),
      this.orders,
      tenantId,
    );
    const before = { evidence, repairs: orderFacts(rows) };
    const after = {
      evidence,
      repairs: orderFacts(rows.filter((row) => row.link.id !== link.id)),
    };
    return repairOrderOrBudget(before) && !repairOrderOrBudget(after);
  }

  public async unlink(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
    linkId: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<Incident> {
    const incident = await this.visible(tenantId, actor, incidentId);
    this.requireEdit(actor);
    const key = this.requiredKey(idempotencyKey);
    const version = parseUnlink(input);
    const wanted = opaqueId(linkId);
    const keyed = this.keyed(incident, UNLINK, key, { version, linkId: wanted ?? null });
    const twin = await this.replay(tenantId, actor, keyed);
    if (twin) return twin.response;
    this.assertLinkable(incident, version);
    const link = (await this.links.links(tenantId, incident.id)).find((row) => row.id === wanted);
    if (!link) throw new IncidentError('not_found');
    if (incident.status === 'repair' && (await this.mustKeepRequirement(tenantId, incident, link)))
      throw new IncidentError('missing_requirements', [], null, ['repair_order_or_budget']);
    const { next, cleared } = withoutApprovals(incident);
    try {
      return await this.commit({
        tenantId,
        actor,
        incident,
        next,
        command: 'repair_unlinked',
        changed: ['repairLinks', ...cleared],
        before: { orderId: link.orderId, linkId: link.id },
        event: (stored) => ({
          type: INCIDENT_REPAIR_UNLINKED_EVENT,
          payload: { incidentId: stored.id, orderId: link.orderId, version: stored.version },
        }),
        write: (mutation) =>
          this.links.apply(mutation, {
            kind: 'unlink',
            tenantId,
            incidentId: incident.id,
            linkId: link.id,
          }),
        keyed,
      });
    } catch (error) {
      if (error instanceof TwinWon) return error.record.response;
      throw error;
    }
  }
}
