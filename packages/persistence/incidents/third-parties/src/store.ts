import 'reflect-metadata';
import { IsNull, type DataSource, type EntityManager } from 'typeorm';
import {
  IncidentError,
  type IncidentApplyResult,
  type IncidentMutation,
  type IncidentStore,
} from '../../../../domain/incidents/cases/src/index.js';
import {
  CHILD_RULES,
  MAX_EVIDENCE,
  MAX_THIRD_PARTIES,
  PROTECTED_FIELDS,
  isSealed,
  type ChildChange,
  type EvidenceRecord,
  type IncidentChildStore,
  type ThirdPartyRecord,
} from '../../../../domain/incidents/third-parties/src/index.js';
import { EvidenceSchema, ThirdPartySchema } from './entities.js';
import { evidenceFrom, evidenceRow, thirdPartyFrom, thirdPartyRow } from './mapping.js';

/** A protected column may only ever hold a `pii1.` envelope (the database checks it too). */
function assertSealed(party: ThirdPartyRecord): void {
  for (const field of PROTECTED_FIELDS)
    if (party.identity[field] !== null && !isSealed(party.identity[field]))
      throw new Error('Third party identity must be sealed before it is stored');
}

/**
 * Children of the cases. Reads carry the tenant in every selector. Writes join the transaction of
 * the incident store (`base`), so the case row (version CAS), timeline, audit, outbox and the child
 * row commit or fail together.
 */
export class TypeOrmIncidentChildStore implements IncidentChildStore {
  public constructor(
    private readonly dataSource: DataSource,
    private readonly base: IncidentStore,
  ) {
    if (dataSource.options.type !== 'mysql' || dataSource.options.synchronize === true)
      throw new Error('Incident children store requires MySQL with synchronize disabled');
  }

  public async thirdParties(
    tenantId: string,
    incidentId: string,
    options: { readonly includeRemoved?: boolean } = {},
  ): Promise<readonly ThirdPartyRecord[]> {
    const rows = await this.dataSource.getRepository(ThirdPartySchema).find({
      where: {
        tenantId,
        incidentId,
        ...(options.includeRemoved === true ? {} : { removedAt: IsNull() }),
      },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    return rows.map(thirdPartyFrom);
  }

  public async evidence(tenantId: string, incidentId: string): Promise<readonly EvidenceRecord[]> {
    const rows = await this.dataSource
      .getRepository(EvidenceSchema)
      .find({ where: { tenantId, incidentId }, order: { attachedAt: 'ASC', id: 'ASC' } });
    return rows.map(evidenceFrom);
  }

  public async evidenceOfFile(tenantId: string, fileId: string): Promise<EvidenceRecord | null> {
    const row = await this.dataSource.getRepository(EvidenceSchema).findOneBy({ tenantId, fileId });
    return row ? evidenceFrom(row) : null;
  }

  private async write(manager: EntityManager, change: ChildChange): Promise<boolean> {
    switch (change.kind) {
      case 'third_party_add': {
        assertSealed(change.party);
        // Counted in the transaction, after the case row was locked by its version check: two
        // concurrent additions cannot both pass the cap (the service checks first, for a quick answer).
        const live = await manager.getRepository(ThirdPartySchema).countBy({
          tenantId: change.party.tenantId,
          incidentId: change.party.incidentId,
          removedAt: IsNull(),
        });
        if (live >= MAX_THIRD_PARTIES)
          throw new IncidentError('rule_violation', [], CHILD_RULES.thirdPartyLimit);
        await manager.getRepository(ThirdPartySchema).insert(thirdPartyRow(change.party));
        return true;
      }
      case 'third_party_update': {
        assertSealed(change.party);
        const { party } = change;
        // A removed third party is gone for good: the guard keeps a late write from reviving it.
        const changed = await manager.getRepository(ThirdPartySchema).update(
          {
            tenantId: party.tenantId,
            incidentId: party.incidentId,
            id: party.id,
            removedAt: IsNull(),
          },
          thirdPartyRow(party),
        );
        return changed.affected === 1;
      }
      case 'evidence_attach': {
        const linked = await manager.getRepository(EvidenceSchema).countBy({
          tenantId: change.evidence.tenantId,
          incidentId: change.evidence.incidentId,
        });
        if (linked >= MAX_EVIDENCE)
          throw new IncidentError('rule_violation', [], CHILD_RULES.evidenceLimit);
        // A second link of the same file trips the unique key (ER_DUP_ENTRY) and rolls everything back.
        await manager.getRepository(EvidenceSchema).insert(evidenceRow(change.evidence));
        return true;
      }
      case 'evidence_detach': {
        const removed = await manager.getRepository(EvidenceSchema).delete({
          tenantId: change.tenantId,
          incidentId: change.incidentId,
          id: change.evidenceId,
        });
        return removed.affected === 1;
      }
    }
  }

  public apply(mutation: IncidentMutation, change: ChildChange): Promise<IncidentApplyResult> {
    return this.base.apply(mutation, {
      run: (tx) => this.write(tx as EntityManager, change),
    });
  }
}
