import type {
  IncidentApplyResult,
  IncidentMutation,
  IncidentStore,
} from '../../cases/src/index.js';
import type { ChildChange, EvidenceRecord, IncidentChildStore, ThirdPartyRecord } from './types.js';
import { isSealed } from './pii.js';
import { PROTECTED_FIELDS } from './catalog.js';

const scope = (tenantId: string, incidentId: string) =>
  `${tenantId.length}:${tenantId}${incidentId}`;

/** A protected column may only ever hold a `pii1.` envelope. */
function assertSealed(party: ThirdPartyRecord): void {
  for (const field of PROTECTED_FIELDS)
    if (party.identity[field] !== null && !isSealed(party.identity[field]))
      throw new Error('Third party identity must be sealed before it is stored');
}

/**
 * In-memory children of the cases, written through the same incident store as the case so that a
 * lost version race or a refused key leaves them untouched. Same semantics as the MySQL adapter.
 */
export class InMemoryIncidentChildStore implements IncidentChildStore {
  private readonly parties = new Map<string, ThirdPartyRecord[]>();
  private readonly links = new Map<string, EvidenceRecord[]>();
  public constructor(private readonly base: IncidentStore) {}

  public async thirdParties(
    tenantId: string,
    incidentId: string,
    options: { readonly includeRemoved?: boolean } = {},
  ): Promise<readonly ThirdPartyRecord[]> {
    return structuredClone(
      (this.parties.get(scope(tenantId, incidentId)) ?? []).filter(
        (party) => options.includeRemoved === true || party.removedAt === null,
      ),
    );
  }

  public async evidence(tenantId: string, incidentId: string): Promise<readonly EvidenceRecord[]> {
    return structuredClone(this.links.get(scope(tenantId, incidentId)) ?? []);
  }

  public async evidenceOfFile(tenantId: string, fileId: string): Promise<EvidenceRecord | null> {
    for (const list of this.links.values())
      for (const link of list)
        if (link.tenantId === tenantId && link.fileId === fileId) return structuredClone(link);
    return null;
  }

  private write(change: ChildChange): boolean {
    switch (change.kind) {
      case 'third_party_add': {
        assertSealed(change.party);
        const key = scope(change.party.tenantId, change.party.incidentId);
        this.parties.set(key, [...(this.parties.get(key) ?? []), structuredClone(change.party)]);
        return true;
      }
      case 'third_party_update': {
        assertSealed(change.party);
        const key = scope(change.party.tenantId, change.party.incidentId);
        const list = this.parties.get(key) ?? [];
        const at = list.findIndex((p) => p.id === change.party.id && p.removedAt === null);
        if (at < 0) return false;
        this.parties.set(
          key,
          list.map((p, i) => (i === at ? structuredClone(change.party) : p)),
        );
        return true;
      }
      case 'evidence_attach': {
        const { evidence } = change;
        for (const list of this.links.values())
          if (list.some((l) => l.tenantId === evidence.tenantId && l.fileId === evidence.fileId))
            return false;
        const key = scope(evidence.tenantId, evidence.incidentId);
        this.links.set(key, [...(this.links.get(key) ?? []), structuredClone(evidence)]);
        return true;
      }
      case 'evidence_detach': {
        const key = scope(change.tenantId, change.incidentId);
        const list = this.links.get(key) ?? [];
        if (!list.some((l) => l.id === change.evidenceId)) return false;
        this.links.set(
          key,
          list.filter((l) => l.id !== change.evidenceId),
        );
        return true;
      }
    }
  }

  public apply(mutation: IncidentMutation, change: ChildChange): Promise<IncidentApplyResult> {
    return this.base.apply(mutation, { run: async () => this.write(change) });
  }
}
