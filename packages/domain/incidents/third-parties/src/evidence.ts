import { createHash } from 'node:crypto';
import {
  IncidentError,
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
  EVIDENCE_CATEGORIES,
  EVIDENCE_MAX_BYTES,
  MAX_EVIDENCE,
  type EvidenceCategory,
} from './catalog.js';
import {
  parseEvidenceAttach,
  parseEvidenceUpload,
  parseVersionOnly,
  type EvidenceAttachInput,
} from './input.js';
import type { EvidenceRecord, IncidentChildStore, IncidentFiles } from './types.js';
import { countsAsEvidence, evidenceView, type EvidenceView } from './views.js';

export interface EvidenceResult {
  /** The case after the command (its new `version` is what the next command sends). */
  readonly incident: Incident;
  readonly evidence: EvidenceView;
}

const ATTACH = 'evidence_attach';

/**
 * Evidence of a case (INC-CASES PR 2). The link is a row of this module; the file belongs to the
 * files module, which keeps the received bytes untouched with their SHA-256 and derives its own
 * view copies (D18, ADR-0014). Only a `clean` file counts as saved evidence.
 */
export class EvidenceService extends ChildServiceBase {
  public constructor(
    incidents: IncidentStore,
    children: IncidentChildStore,
    private readonly files: IncidentFiles,
    options: ChildServiceOptions = {},
  ) {
    super(incidents, children, options);
  }

  private async viewOf(tenantId: string, record: EvidenceRecord): Promise<EvidenceView> {
    const file = await this.files.record(tenantId, record.fileId);
    return evidenceView(record, file?.status ?? 'missing');
  }

  public async list(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
  ): Promise<readonly EvidenceView[]> {
    const incident = await this.visible(tenantId, actor, incidentId);
    const records = await this.children.evidence(tenantId, incident.id);
    return Promise.all(records.map((record) => this.viewOf(tenantId, record)));
  }

  /** Clean files per category: the figure a workflow requirement (a photo, a budget) is checked against. */
  public async cleanCounts(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
  ): Promise<Readonly<Record<EvidenceCategory, number>>> {
    const counts = Object.fromEntries(EVIDENCE_CATEGORIES.map((c) => [c, 0])) as Record<
      EvidenceCategory,
      number
    >;
    for (const item of await this.list(tenantId, actor, incidentId))
      if (countsAsEvidence(item.fileStatus)) counts[item.category] += 1;
    return counts;
  }

  /**
   * The link of a file to download: the caller must see the case, and the file must be `clean`.
   * A file in quarantine or a rejected one is never served.
   */
  public async downloadable(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
    evidenceId: string,
  ): Promise<EvidenceRecord> {
    const incident = await this.visible(tenantId, actor, incidentId);
    const wanted = opaqueId(evidenceId);
    const link = (await this.children.evidence(tenantId, incident.id)).find(
      (candidate) => candidate.id === wanted,
    );
    if (!link) throw new IncidentError('not_found');
    const file = await this.files.record(tenantId, link.fileId);
    if (!file) throw new IncidentError('not_found');
    if (!countsAsEvidence(file.status)) throw new IncidentError('invalid_transition');
    return link;
  }

  /** Checks that run before any byte is stored: the caller, the state, the version and the limit. */
  private async prepare(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
    version: number,
  ): Promise<Incident> {
    const incident = await this.writable(tenantId, actor, incidentId);
    this.assertOpen(incident, version);
    const linked = await this.children.evidence(tenantId, incident.id);
    if (linked.length >= MAX_EVIDENCE)
      throw new IncidentError('rule_violation', [], CHILD_RULES.evidenceLimit);
    return incident;
  }

  /**
   * Stores the upload and links it. The received bytes are the preserved original: they are never
   * compressed, resized or replaced here, whether or not the web compressed them first.
   */
  public async upload(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
    input: unknown,
    bytes: Uint8Array,
    correlationId: string,
    idempotencyKey?: string,
  ): Promise<EvidenceResult> {
    const incident = await this.writable(tenantId, actor, incidentId);
    const key = this.keyOf(idempotencyKey);
    const parsed = parseEvidenceUpload(input);
    if (bytes.length === 0 || bytes.length > EVIDENCE_MAX_BYTES)
      throw new IncidentError('invalid_input', [{ field: 'contentBase64', code: 'invalid' }]);
    const keyed: KeyedCommand | undefined =
      key === undefined
        ? undefined
        : {
            command: ATTACH,
            key,
            hash: payloadHash(incident.id, ATTACH, {
              ...parsed,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            }),
          };
    if (keyed) {
      const record = await this.replay(tenantId, actor, keyed);
      if (record) return this.replayed(tenantId, actor, incident.id, keyed.key, record.response);
    }
    await this.prepare(tenantId, actor, incident.id, parsed.version);
    const stored = await this.files.ingest(tenantId, actor.id, correlationId, {
      name: parsed.name,
      contentType: parsed.contentType,
      bytes,
    });
    return this.link(tenantId, actor, incident.id, { ...parsed, fileId: stored.id }, keyed);
  }

  /** Links an existing file of the files module (uploaded by the same caller) to the case. */
  public async attach(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
    input: unknown,
  ): Promise<EvidenceResult> {
    return this.link(tenantId, actor, incidentId, parseEvidenceAttach(input), undefined);
  }

  private async replayed(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
    key: string,
    stored: Incident,
  ): Promise<EvidenceResult> {
    const id = keyedId(tenantId, actor.id, ATTACH, key);
    const link = (await this.children.evidence(tenantId, incidentId)).find(
      (candidate) => candidate.id === id,
    );
    if (!link) throw new IncidentError('duplicate');
    return { incident: stored, evidence: await this.viewOf(tenantId, link) };
  }

  private async link(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
    input: EvidenceAttachInput,
    keyed: KeyedCommand | undefined,
  ): Promise<EvidenceResult> {
    const incident = await this.prepare(tenantId, actor, incidentId, input.version);
    const file = await this.files.record(tenantId, input.fileId);
    // A file of another tenant or one the caller did not upload looks the same as an unknown one.
    if (!file || file.createdBy !== actor.id) throw new IncidentError('not_found');
    if (file.kind !== 'original' || file.sensitivity !== 'standard')
      throw new IncidentError('invalid_input', [{ field: 'fileId', code: 'invalid' }]);
    // An upload intent or a rejected file is not evidence; a file still in the scan is shown as such.
    if (file.status !== 'pending_scan' && file.status !== 'clean')
      throw new IncidentError('invalid_input', [{ field: 'fileId', code: 'invalid' }]);
    // One link per file in the tenant, whichever case holds it.
    if (await this.children.evidenceOfFile(tenantId, file.id)) throw new IncidentError('duplicate');
    const evidence: EvidenceRecord = {
      id: keyed ? keyedId(tenantId, actor.id, ATTACH, keyed.key) : this.newId(),
      tenantId,
      incidentId: incident.id,
      fileId: file.id,
      category: input.category,
      stage: input.stage,
      capturedAt: input.capturedAt,
      clientCompressed: input.clientCompressed,
      displayName: file.displayName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      attachedBy: actor.id,
      attachedAt: this.now().toISOString(),
    };
    try {
      const next = await this.commit({
        tenantId,
        actor,
        incident,
        command: 'evidence_attached',
        changed: ['evidence'],
        before: { evidenceId: evidence.id, category: evidence.category, stage: evidence.stage },
        change: { kind: 'evidence_attach', evidence },
        ...(keyed ? { keyed } : {}),
      });
      return { incident: next, evidence: evidenceView(evidence, file.status) };
    } catch (error) {
      if (error instanceof TwinWon && keyed)
        return this.replayed(tenantId, actor, incident.id, keyed.key, error.record.response);
      throw error;
    }
  }

  /** Detaching removes the link only; the original file stays in the files module (D18). */
  public async detach(
    tenantId: string,
    actor: IncidentActor,
    incidentId: string,
    evidenceId: string,
    input: unknown,
  ): Promise<Incident> {
    const incident = await this.writable(tenantId, actor, incidentId);
    const version = parseVersionOnly(input);
    this.assertOpen(incident, version);
    const wanted = opaqueId(evidenceId);
    const link = (await this.children.evidence(tenantId, incident.id)).find(
      (candidate) => candidate.id === wanted,
    );
    if (!link) throw new IncidentError('not_found');
    return this.commit({
      tenantId,
      actor,
      incident,
      command: 'evidence_detached',
      changed: ['evidence'],
      before: { evidenceId: link.id, category: link.category, stage: link.stage },
      change: {
        kind: 'evidence_detach',
        tenantId,
        incidentId: incident.id,
        evidenceId: link.id,
      },
    });
  }
}
