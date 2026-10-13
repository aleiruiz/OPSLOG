import { IncidentError } from '../../../../../packages/domain/incidents/cases/src/index.js';
import {
  EVIDENCE_MAX_BYTES,
  identityVisible,
  type EvidenceView,
} from '../../../../../packages/domain/incidents/third-parties/src/index.js';
import { runSession } from '../../cases/src/session.js';
import type {
  EvidenceChangeView,
  EvidenceContentView,
  EvidenceItemView,
  IncidentChildApiDeps,
  IncidentVersionView,
  PersonRef,
  ThirdPartyChangeView,
  ThirdPartyListView,
} from './types.js';
import type { IncidentApiResponse } from '../../cases/src/index.js';

export type * from './types.js';

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** The longest base64 text a file of the largest allowed size can have. */
const MAX_BASE64_LENGTH = Math.ceil((EVIDENCE_MAX_BYTES * 4) / 3) + 4;
const invalidFile = () =>
  new IncidentError('invalid_input', [{ field: 'contentBase64', code: 'invalid' }]);

/** Splits the base64 payload from the metadata and decodes it; the decoded size is what counts. */
function decode(input: unknown): { rest: Record<string, unknown>; bytes: Uint8Array } {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new IncidentError('invalid_input', [{ field: 'body', code: 'invalid' }]);
  const { contentBase64, ...rest } = input as Record<string, unknown>;
  if (contentBase64 === undefined)
    throw new IncidentError('invalid_input', [{ field: 'contentBase64', code: 'required' }]);
  if (
    typeof contentBase64 !== 'string' ||
    contentBase64.length === 0 ||
    contentBase64.length > MAX_BASE64_LENGTH ||
    contentBase64.length % 4 !== 0 ||
    !BASE64.test(contentBase64)
  )
    throw invalidFile();
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.length === 0 || bytes.length > EVIDENCE_MAX_BYTES) throw invalidFile();
  return { rest, bytes };
}

/** Third parties and evidence of a case. Tenant, actor and grants come only from the session. */
export class IncidentChildApi {
  public constructor(private readonly deps: IncidentChildApiDeps) {}

  private async person(tenantId: string, actorId: string): Promise<PersonRef> {
    return {
      id: actorId.replace(/^user-/, ''),
      displayName: await this.deps.labels.member(tenantId, actorId),
    };
  }

  private async item(tenantId: string, view: EvidenceView): Promise<EvidenceItemView> {
    const { attachedBy, ...rest } = view;
    return { ...rest, attachedBy: await this.person(tenantId, attachedBy) };
  }

  public listThirdParties(
    token: string,
    correlationId: string,
    incidentId: string,
  ): Promise<IncidentApiResponse<ThirdPartyListView>> {
    return runSession(this.deps, token, correlationId, incidentId, async (tenantId, actor) => ({
      items: await this.deps.thirdParties.list(tenantId, actor, incidentId),
      identityRestricted: !identityVisible(actor),
    }));
  }

  public createThirdParty(
    token: string,
    correlationId: string,
    incidentId: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<IncidentApiResponse<ThirdPartyChangeView>> {
    return runSession(this.deps, token, correlationId, incidentId, async (tenantId, actor) => {
      const { incident, party } = await this.deps.thirdParties.create(
        tenantId,
        actor,
        incidentId,
        input,
        idempotencyKey,
      );
      return { version: incident.version, item: party };
    });
  }

  public updateThirdParty(
    token: string,
    correlationId: string,
    incidentId: string,
    partyId: string,
    input: unknown,
  ): Promise<IncidentApiResponse<ThirdPartyChangeView>> {
    return runSession(this.deps, token, correlationId, incidentId, async (tenantId, actor) => {
      const { incident, party } = await this.deps.thirdParties.update(
        tenantId,
        actor,
        incidentId,
        partyId,
        input,
      );
      return { version: incident.version, item: party };
    });
  }

  public removeThirdParty(
    token: string,
    correlationId: string,
    incidentId: string,
    partyId: string,
    input: unknown,
  ): Promise<IncidentApiResponse<IncidentVersionView>> {
    return runSession(this.deps, token, correlationId, incidentId, async (tenantId, actor) => ({
      version: (await this.deps.thirdParties.remove(tenantId, actor, incidentId, partyId, input))
        .version,
    }));
  }

  public listEvidence(
    token: string,
    correlationId: string,
    incidentId: string,
  ): Promise<IncidentApiResponse<readonly EvidenceItemView[]>> {
    return runSession(this.deps, token, correlationId, incidentId, async (tenantId, actor) =>
      Promise.all(
        (await this.deps.evidence.list(tenantId, actor, incidentId)).map((view) =>
          this.item(tenantId, view),
        ),
      ),
    );
  }

  /**
   * Stores the upload and links it to the case. The caller, the state and the version are checked
   * before any byte is stored; the file is owned by the actor that links it.
   */
  public uploadEvidence(
    token: string,
    correlationId: string,
    incidentId: string,
    input: unknown,
    idempotencyKey?: string,
  ): Promise<IncidentApiResponse<EvidenceChangeView>> {
    return runSession(this.deps, token, correlationId, incidentId, async (tenantId, actor) => {
      const { rest, bytes } = decode(input);
      const { incident, evidence } = await this.deps.evidence.upload(
        tenantId,
        actor,
        incidentId,
        rest,
        bytes,
        correlationId,
        idempotencyKey,
      );
      return { version: incident.version, item: await this.item(tenantId, evidence) };
    });
  }

  public detachEvidence(
    token: string,
    correlationId: string,
    incidentId: string,
    evidenceId: string,
    input: unknown,
  ): Promise<IncidentApiResponse<IncidentVersionView>> {
    return runSession(this.deps, token, correlationId, incidentId, async (tenantId, actor) => ({
      version: (await this.deps.evidence.detach(tenantId, actor, incidentId, evidenceId, input))
        .version,
    }));
  }

  /** Authenticated proxy download of a clean file; the access is audited before any byte leaves. */
  public evidenceContent(
    token: string,
    correlationId: string,
    incidentId: string,
    evidenceId: string,
  ): Promise<IncidentApiResponse<EvidenceContentView>> {
    return runSession(
      this.deps,
      token,
      correlationId,
      incidentId,
      async (tenantId, actor, context) => {
        const link = await this.deps.evidence.downloadable(tenantId, actor, incidentId, evidenceId);
        await this.deps.audit(
          context,
          'incident.evidence_downloaded',
          link.incidentId,
          correlationId,
        );
        const bytes = await this.deps.files.read(token, correlationId, link.fileId);
        return {
          displayName: link.displayName,
          contentType: link.contentType,
          contentBase64: Buffer.from(bytes).toString('base64'),
        };
      },
    );
  }
}
