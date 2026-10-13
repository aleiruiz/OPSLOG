import {
  incidentView,
  transitionView,
  type Incident,
  type IncidentActor,
  type IncidentSuggestions,
  type IncidentTransition,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import type {
  CoverageAlert,
  IncidentLabels,
  IncidentSuggestionsView,
  IncidentTimelineEntry,
  IncidentView,
  PersonRef,
} from './types.js';

const UNKNOWN_VEHICLE = 'Vehículo no disponible';
const UNKNOWN_DRIVER = 'Conductor no disponible';

export const alertOf = (status: Incident['coverageStatus']): CoverageAlert | null =>
  status === 'none' ? 'no_policy_on_event_day' : status === 'multiple' ? 'several_policies' : null;

/** Names are resolved once per distinct id in a response, never once per row. */
class Names {
  private readonly vehicles = new Map<string, ReturnType<IncidentLabels['vehicle']>>();
  private readonly drivers = new Map<string, Promise<string | null>>();
  private readonly members = new Map<string, Promise<string>>();
  public constructor(
    private readonly tenantId: string,
    private readonly labels: IncidentLabels,
  ) {}
  public vehicle(id: string) {
    if (!this.vehicles.has(id)) this.vehicles.set(id, this.labels.vehicle(this.tenantId, id));
    return this.vehicles.get(id) as ReturnType<IncidentLabels['vehicle']>;
  }
  public driver(id: string) {
    if (!this.drivers.has(id)) this.drivers.set(id, this.labels.driver(this.tenantId, id));
    return this.drivers.get(id) as Promise<string | null>;
  }
  public async person(actorId: string): Promise<PersonRef> {
    if (!this.members.has(actorId))
      this.members.set(actorId, this.labels.member(this.tenantId, actorId));
    return {
      id: actorId.replace(/^user-/, ''),
      displayName: await (this.members.get(actorId) as Promise<string>),
    };
  }
}

export const namesFor = (tenantId: string, labels: IncidentLabels) => new Names(tenantId, labels);
export type { Names };

export async function toView(
  incident: Incident,
  actor: IncidentActor,
  names: Names,
): Promise<IncidentView> {
  const rest = incidentView(incident, actor);
  const [vehicle, driver, createdBy, responsible, reportedBy] = await Promise.all([
    names.vehicle(incident.vehicleId),
    incident.driverId ? names.driver(incident.driverId) : null,
    names.person(incident.createdBy),
    incident.responsibleId ? names.person(incident.responsibleId) : null,
    incident.reportedBy ? names.person(incident.reportedBy) : null,
  ]);
  return {
    id: rest.id,
    folio: rest.folio,
    status: rest.status,
    version: rest.version,
    cycle: rest.cycle,
    reopenCount: rest.reopenCount,
    type: rest.type,
    severity: rest.severity,
    vehicle: {
      id: incident.vehicleId,
      economicNumber: vehicle?.economicNumber ?? UNKNOWN_VEHICLE,
      plate: vehicle?.plate ?? '',
    },
    driver: incident.driverId
      ? { employeeId: incident.driverId, displayName: driver ?? UNKNOWN_DRIVER }
      : null,
    noDriverReason: rest.noDriverReason,
    occurredAt: rest.occurredAt,
    occurredOn: rest.occurredOn,
    location: rest.location,
    description: rest.description,
    vehicleOperable: rest.vehicleOperable,
    damage: rest.damage,
    noPhotoJustification: rest.noPhotoJustification,
    coverage: {
      status: rest.coverageStatus,
      policy: rest.policySnapshot,
      alert: alertOf(rest.coverageStatus),
    },
    vehicleProposal: rest.vehicleProposal,
    insurance: null,
    resolution: null,
    reportedAt: rest.reportedAt,
    createdAt: rest.createdAt,
    updatedAt: rest.updatedAt,
    createdBy,
    responsible,
    reportedBy,
    editableFields: rest.editableFields,
  };
}

export async function toTimeline(
  entries: readonly IncidentTransition[],
  names: Names,
): Promise<readonly IncidentTimelineEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      const view = transitionView(entry);
      return {
        sequence: view.sequence,
        command: view.command,
        from: view.from,
        to: view.to,
        actor: await names.person(view.actorId),
        comment: view.comment,
        occurredAt: view.occurredAt,
        changedFields: view.changedFields,
        before: view.before,
      };
    }),
  );
}

export function toSuggestions(suggestions: IncidentSuggestions): IncidentSuggestionsView {
  return {
    drivers: suggestions.drivers,
    policies: suggestions.policies,
    coverage: { status: suggestions.coverageStatus, alert: alertOf(suggestions.coverageStatus) },
  };
}
