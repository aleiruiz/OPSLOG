import {
  IncidentError,
  canView,
  can,
  payloadHash,
  type Incident,
  type IncidentActor,
  type IncidentStore,
} from '../../cases/src/index.js';
import { opaqueId } from '../../cases/src/validation.js';
import {
  ChildServiceBase,
  TwinWon,
  keyedId,
  type ChildServiceOptions,
  type KeyedCommand,
} from './base.js';
import {
  CHILD_RULES,
  MAX_THIRD_PARTIES,
  PROTECTED_FIELDS,
  type ProtectedField,
} from './catalog.js';
import {
  parseThirdPartyCreate,
  parseThirdPartyPatch,
  parseVersionOnly,
  type ThirdPartyChanges,
} from './input.js';
import type { IdentityVault } from './pii.js';
import type { IncidentChildStore, SealedIdentity, ThirdPartyRecord } from './types.js';
import type { ThirdPartyView } from './views.js';

export interface ThirdPartyResult {
  /** The case after the command (its new `version` is what the next command sends). */
  readonly incident: Incident;
  readonly party: ThirdPartyView;
}

const ADD = 'third_party_add';

/** Identity needs `incidents:view` and the generic `view_pii` (SPECS D23, ADR-0014). */
export const identityVisible = (actor: IncidentActor): boolean =>
  canView(actor) && can(actor, 'view_pii');
const EMPTY_IDENTITY: SealedIdentity = {
  name: null,
  contact: null,
  plates: null,
  policyNumber: null,
};
const PLAIN = ['kind', 'insurerName', 'damageDescription', 'injuries'] as const;

/** Third parties of a case (INC-CASES PR 2): identity sealed at rest, shown only with `view_pii` (D23). */
export class ThirdPartyService extends ChildServiceBase {
  public constructor(
    incidents: IncidentStore,
    children: IncidentChildStore,
    private readonly vault: IdentityVault,
    options: ChildServiceOptions = {},
  ) {
    super(incidents, children, options);
  }

  private async view(
    tenantId: string,
    actor: IncidentActor,
    record: ThirdPartyRecord,
  ): Promise<ThirdPartyView> {
    const base = {
      id: record.id,
      kind: record.kind,
      insurerName: record.insurerName,
      damageDescription: record.damageDescription,
      injuries: record.injuries,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    if (!identityVisible(actor)) return { ...base, identityRestricted: true };
    const opened: Partial<Record<ProtectedField, string | null>> = {};
    for (const field of PROTECTED_FIELDS) {
      const sealed = record.identity[field];
      opened[field] =
        sealed === null
          ? null
          : await this.vault.open(tenantId, record.incidentId, record.id, field, sealed);
    }
    return { ...base, ...opened, identityRestricted: false };
  }

  public async list(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
  ): Promise<readonly ThirdPartyView[]> {
    const incident = await this.visible(tenantId, actor, incidentId);
    const records = await this.children.thirdParties(tenantId, incident.id);
    return Promise.all(records.map((record) => this.view(tenantId, actor, record)));
  }

  private async seal(
    tenantId: string,
    incidentId: string,
    partyId: string,
    changes: ThirdPartyChanges,
  ): Promise<Partial<Record<ProtectedField, string | null>>> {
    const sealed: Partial<Record<ProtectedField, string | null>> = {};
    for (const field of PROTECTED_FIELDS) {
      const value = changes[field];
      if (value !== undefined)
        sealed[field] =
          value === null
            ? null
            : await this.vault.seal(tenantId, incidentId, partyId, field, value);
    }
    return sealed;
  }

  private async keyed(
    tenantId: string,
    incident: Incident,
    version: number,
    changes: ThirdPartyChanges,
    key: string | undefined,
  ): Promise<KeyedCommand | undefined> {
    if (key === undefined) return undefined;
    const protectedValues = Object.fromEntries(
      PROTECTED_FIELDS.filter((field) => changes[field] !== undefined).map((field) => [
        field,
        changes[field] as string | null,
      ]),
    );
    const plain = Object.fromEntries(
      PLAIN.filter((field) => changes[field] !== undefined).map((field) => [field, changes[field]]),
    );
    return {
      command: ADD,
      key,
      hash: payloadHash(incident.id, ADD, {
        version,
        ...plain,
        identity: await this.vault.fingerprint(tenantId, protectedValues),
      }),
    };
  }

  /** What the first call with this key made, shaped for this caller. */
  private async replayed(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
    key: string,
    stored: Incident,
  ): Promise<ThirdPartyResult> {
    const id = keyedId(tenantId, actor.id, ADD, key);
    const party = (
      await this.children.thirdParties(tenantId, incidentId, { includeRemoved: true })
    ).find((candidate) => candidate.id === id);
    if (!party) throw new IncidentError('duplicate');
    return { incident: stored, party: await this.view(tenantId, actor, party) };
  }

  public async create(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<ThirdPartyResult> {
    const incident = await this.writable(tenantId, actor, incidentId);
    const key = this.keyOf(idempotencyKey);
    const { version, changes } = parseThirdPartyCreate(input);
    const keyed = await this.keyed(tenantId, incident, version, changes, key);
    if (keyed) {
      const record = await this.replay(tenantId, actor, keyed);
      if (record) return this.replayed(tenantId, actor, incident.id, keyed.key, record.response);
    }
    this.assertOpen(incident, version);
    const active = await this.children.thirdParties(tenantId, incident.id);
    if (active.length >= MAX_THIRD_PARTIES)
      throw new IncidentError('rule_violation', [], CHILD_RULES.thirdPartyLimit);
    const id = keyed ? keyedId(tenantId, actor.id, ADD, keyed.key) : this.newId();
    const sealed = await this.seal(tenantId, incident.id, id, changes);
    const time = this.now().toISOString();
    const record: ThirdPartyRecord = {
      id,
      tenantId,
      incidentId: incident.id,
      kind: changes.kind as ThirdPartyRecord['kind'],
      identity: { ...EMPTY_IDENTITY, ...sealed },
      insurerName: changes.insurerName ?? null,
      damageDescription: changes.damageDescription ?? null,
      injuries: changes.injuries ?? false,
      removedAt: null,
      createdAt: time,
      createdBy: actor.id,
      updatedAt: time,
      updatedBy: actor.id,
    };
    const changed = Object.entries(changes)
      .filter(([, value]) => value !== null)
      .map(([name]) => name);
    try {
      const next = await this.commit({
        tenantId,
        actor,
        incident,
        command: 'third_party_added',
        changed,
        before: { thirdPartyId: id, kind: record.kind },
        change: { kind: 'third_party_add', party: record },
        ...(keyed ? { keyed } : {}),
      });
      return { incident: next, party: await this.view(tenantId, actor, record) };
    } catch (error) {
      if (error instanceof TwinWon && keyed)
        return this.replayed(tenantId, actor, incident.id, keyed.key, error.record.response);
      throw error;
    }
  }

  private async active(
    tenantId: string,
    incident: Incident,
    partyId: string,
  ): Promise<ThirdPartyRecord> {
    const wanted = opaqueId(partyId);
    const found = (await this.children.thirdParties(tenantId, incident.id)).find(
      (party) => party.id === wanted,
    );
    if (!found) throw new IncidentError('not_found');
    return found;
  }

  public async update(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
    partyId: string,
    input: unknown,
  ): Promise<ThirdPartyResult> {
    const incident = await this.writable(tenantId, actor, incidentId);
    const { version, changes } = parseThirdPartyPatch(input);
    this.assertOpen(incident, version);
    const current = await this.active(tenantId, incident, partyId);
    const changed: string[] = PLAIN.filter(
      (field) => changes[field] !== undefined && changes[field] !== current[field],
    );
    const sealed = await this.seal(tenantId, incident.id, current.id, changes);
    const identity: Record<ProtectedField, string | null> = { ...current.identity };
    for (const field of PROTECTED_FIELDS) {
      const next = sealed[field];
      // A sealed value never repeats (random IV): a request to set one is always a change.
      if (next === undefined || (next === null && current.identity[field] === null)) continue;
      identity[field] = next;
      changed.push(field);
    }
    if (changed.length === 0) return { incident, party: await this.view(tenantId, actor, current) };
    const time = this.now().toISOString();
    const record: ThirdPartyRecord = {
      ...current,
      kind: changes.kind ?? current.kind,
      identity,
      insurerName: changes.insurerName === undefined ? current.insurerName : changes.insurerName,
      damageDescription:
        changes.damageDescription === undefined
          ? current.damageDescription
          : changes.damageDescription,
      injuries: changes.injuries ?? current.injuries,
      updatedAt: time,
      updatedBy: actor.id,
    };
    const next = await this.commit({
      tenantId,
      actor,
      incident,
      command: 'third_party_updated',
      changed,
      before: { thirdPartyId: current.id, kind: current.kind },
      change: { kind: 'third_party_update', party: record },
    });
    return { incident: next, party: await this.view(tenantId, actor, record) };
  }

  /** Soft delete: the row stays for the record of the case but leaves the list. */
  public async remove(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
    partyId: string,
    input: unknown,
  ): Promise<Incident> {
    const incident = await this.writable(tenantId, actor, incidentId);
    const version = parseVersionOnly(input);
    this.assertOpen(incident, version);
    const current = await this.active(tenantId, incident, partyId);
    const time = this.now().toISOString();
    return this.commit({
      tenantId,
      actor,
      incident,
      command: 'third_party_removed',
      changed: ['removedAt'],
      before: { thirdPartyId: current.id, kind: current.kind },
      change: {
        kind: 'third_party_update',
        party: { ...current, removedAt: time, updatedAt: time, updatedBy: actor.id },
      },
    });
  }
}
