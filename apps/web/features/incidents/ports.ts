import type {
  BffClient,
  BffIncident,
  BffIncidentEvidence,
  BffIncidentEvidenceChange,
  BffIncidentEvidenceContent,
  BffIncidentEvidenceUpload,
  BffIncidentInput,
  BffIncidentInsuranceInput,
  BffIncidentNextStep,
  BffIncidentPatch,
  BffIncidentResolutionInput,
  BffIncidentSuggestions,
  BffIncidentSuggestionsQuery,
  BffIncidentTimelineEntry,
  BffIncidentTransitionInput,
  BffIncidentVersion,
  BffIncidentsQuery,
  BffThirdPartyChange,
  BffThirdPartyInput,
  BffThirdPartyList,
  BffThirdPartyPatch,
  BffVehicleStatus,
  Page,
} from '@opslog/contracts';
import type { Result } from '../../app/types';

/**
 * What the incident screens need from the BFF, one method per accepted contract route (INC-CASES and
 * INC-WORKFLOW). Authorization, requirements and states stay on the server; these ports only carry
 * requests. `idempotencyKey` travels as the Idempotency-Key header.
 */
export interface IncidentPorts {
  list(query?: BffIncidentsQuery): Promise<Result<Page<BffIncident>>>;
  get(id: string): Promise<Result<BffIncident>>;
  create(body: BffIncidentInput, idempotencyKey: string): Promise<Result<BffIncident>>;
  update(id: string, body: BffIncidentPatch): Promise<Result<BffIncident>>;
  suggestions(query: BffIncidentSuggestionsQuery): Promise<Result<BffIncidentSuggestions>>;
  timeline(id: string): Promise<Result<{ readonly items: readonly BffIncidentTimelineEntry[] }>>;
  nextSteps(id: string): Promise<Result<{ readonly items: readonly BffIncidentNextStep[] }>>;
  transition(
    id: string,
    body: BffIncidentTransitionInput,
    idempotencyKey: string,
  ): Promise<Result<BffIncident>>;
  updateInsurance(id: string, body: BffIncidentInsuranceInput): Promise<Result<BffIncident>>;
  updateResolution(id: string, body: BffIncidentResolutionInput): Promise<Result<BffIncident>>;
  readonly thirdParties: {
    list(id: string): Promise<Result<BffThirdPartyList>>;
    create(
      id: string,
      body: BffThirdPartyInput,
      idempotencyKey: string,
    ): Promise<Result<BffThirdPartyChange>>;
    update(
      id: string,
      partyId: string,
      body: BffThirdPartyPatch,
    ): Promise<Result<BffThirdPartyChange>>;
    remove(id: string, partyId: string, version: number): Promise<Result<BffIncidentVersion>>;
  };
  readonly evidence: {
    list(id: string): Promise<Result<{ readonly items: readonly BffIncidentEvidence[] }>>;
    upload(
      id: string,
      body: BffIncidentEvidenceUpload,
      idempotencyKey: string,
    ): Promise<Result<BffIncidentEvidenceChange>>;
    detach(id: string, evidenceId: string, version: number): Promise<Result<BffIncidentVersion>>;
    content(id: string, evidenceId: string): Promise<Result<BffIncidentEvidenceContent>>;
  };
  /**
   * The explicit, human-triggered status change of the vehicles module that a vehicle proposal asks for
   * (BR-I5, D11). It reads the vehicle's current version, then applies the status with the reason given.
   */
  readonly vehicles: {
    applyStatus(vehicleId: string, status: BffVehicleStatus, reason: string): Promise<Result<null>>;
  };
}

/** The ports over the typed BFF client; method, path and CSRF come from the contract module. */
export function createIncidentPorts(client: BffClient): IncidentPorts {
  const { call } = client;
  return {
    list: (query) => (query ? call('incidents.list', { query }) : call('incidents.list')),
    get: (incidentId) => call('incidents.get', { params: { incidentId } }),
    create: (body, idempotencyKey) => call('incidents.create', { body, idempotencyKey }),
    update: (incidentId, body) => call('incidents.update', { params: { incidentId }, body }),
    suggestions: (query) => call('incidents.suggestions', { query }),
    timeline: (incidentId) => call('incidents.timeline', { params: { incidentId } }),
    nextSteps: (incidentId) => call('incidents.nextSteps', { params: { incidentId } }),
    transition: (incidentId, body, idempotencyKey) =>
      call('incidents.transition', { params: { incidentId }, body, idempotencyKey }),
    updateInsurance: (incidentId, body) =>
      call('incidents.insurance.update', { params: { incidentId }, body }),
    updateResolution: (incidentId, body) =>
      call('incidents.resolution.update', { params: { incidentId }, body }),
    thirdParties: {
      list: (incidentId) => call('incidents.thirdParties.list', { params: { incidentId } }),
      create: (incidentId, body, idempotencyKey) =>
        call('incidents.thirdParties.create', { params: { incidentId }, body, idempotencyKey }),
      update: (incidentId, partyId, body) =>
        call('incidents.thirdParties.update', { params: { incidentId, partyId }, body }),
      remove: (incidentId, partyId, version) =>
        call('incidents.thirdParties.remove', {
          params: { incidentId, partyId },
          body: { version },
        }),
    },
    evidence: {
      list: (incidentId) => call('incidents.evidence.list', { params: { incidentId } }),
      upload: (incidentId, body, idempotencyKey) =>
        call('incidents.evidence.upload', { params: { incidentId }, body, idempotencyKey }),
      detach: (incidentId, evidenceId, version) =>
        call('incidents.evidence.detach', {
          params: { incidentId, evidenceId },
          body: { version },
        }),
      content: (incidentId, evidenceId) =>
        call('incidents.evidence.content', { params: { incidentId, evidenceId } }),
    },
    vehicles: {
      applyStatus: async (id, status, reason) => {
        const vehicle = await call('vehicles.get', { params: { id } });
        if (!vehicle.ok) return vehicle;
        const changed = await call('vehicles.status', {
          params: { id },
          body: { version: vehicle.value.version, status, reason },
        });
        return changed.ok ? { ok: true, value: null } : changed;
      },
    },
  };
}
