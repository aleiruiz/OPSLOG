import {
  InMemoryIncidentStore,
  IncidentService,
  type Incident,
  type IncidentActor,
  type NewIncidentTransition,
} from '../../cases/src/index.js';
import {
  FakeReferences,
  revision,
  MANAGER,
  NOW,
  OTHER_REPORTER,
  REPORTER,
  TENANT_A,
  VEHICLE,
  actorOf,
} from '../../cases/src/test-support.js';
import { FAIL_CLOSED_COSTS, FAIL_CLOSED_REPAIRS, FAIL_CLOSED_TOTALS } from './fail-closed.js';
import {
  InMemoryIncidentClosures,
  type ClosureCostsRequest,
  type IncidentClosureCosts,
} from './closures.js';
import type {
  IncidentVehicleBlocks,
  CostPresence,
  CostTotals,
  CostThreshold,
  EvidenceFact,
  IncidentCostPresence,
  IncidentCostTotals,
  IncidentEvidenceFacts,
  IncidentRepairs,
  RepairsSnapshot,
  ReportPhotoMode,
  ResponsibleDirectory,
  WorkflowPorts,
  WorkflowSettings,
} from './ports.js';
import { IncidentProcessService } from './process.js';
import { IncidentWorkflowService } from './service.js';

export { MANAGER, NOW, OTHER_REPORTER, REPORTER, TENANT_A, VEHICLE, actorOf, revision };

/** Everything a case may need to be reported, so tests start from a complete draft. */
export const COMPLETE = {
  vehicleId: VEHICLE,
  type: 'collision',
  severity: 'medium',
  driverId: 'driver-1',
  vehicleOperable: true,
  occurredAt: '2026-10-13T12:00:00.000Z',
  location: { text: 'Av. Sintética 123' },
  description: 'Choque lateral sintético',
  noPhotoJustification: 'Sin cámara a la mano',
} as const;

const ALL_INCIDENTS = [
  'incidents:view',
  'incidents:create',
  'incidents:edit',
  'incidents:report',
  'incidents:approve',
  'incidents:close',
  'incidents:reopen',
  'incidents:view_costs',
] as const;
export const ADMIN = actorOf('00000000-0000-4000-8000-0000000000a1', ALL_INCIDENTS);
export const VIEWER = actorOf('00000000-0000-4000-8000-0000000000a2', ['incidents:view']);
/** A fleet editor with the generic verbs and no incident right (ADR-0014). */
export const FLEET_EDITOR = actorOf('00000000-0000-4000-8000-0000000000a3', [
  'view',
  'create',
  'edit',
  'incidents:view',
]);

export class FakeEvidence implements IncidentEvidenceFacts {
  public items: EvidenceFact[] = [];
  public async evidence(): Promise<readonly EvidenceFact[]> {
    return this.items;
  }
  public add(
    category: EvidenceFact['category'],
    clean = true,
    stage: EvidenceFact['stage'] = 'on_site',
    pending = !clean,
  ) {
    this.items.push({ id: `ev-${this.items.length + 1}`, category, stage, clean, pending });
  }
}
export class FakeRepairs implements IncidentRepairs {
  public snapshot: RepairsSnapshot = { available: true, orders: [] };
  public async linkedOrders(): Promise<RepairsSnapshot> {
    return this.snapshot;
  }
}
export class FakeCosts implements IncidentCostPresence, IncidentCostTotals {
  public costs: CostPresence = { available: true, hasCosts: false, hasRepairLine: false };
  public borne: CostTotals = { available: true, companyBorne: [] };
  public async presence(): Promise<CostPresence> {
    return this.costs;
  }
  public async totals(): Promise<CostTotals> {
    return this.borne;
  }
}
export class FakeBlocks implements IncidentVehicleBlocks {
  public blocked_ = false;
  public fail = false;
  public async blocked(): Promise<boolean> {
    if (this.fail) throw new Error('blocks unavailable');
    return this.blocked_;
  }
}
/** Records the snapshots INC-COSTS would keep; can be told to fail, to prove the closure is atomic. */
export class FakeClosureCosts implements IncidentClosureCosts {
  public readonly taken: ClosureCostsRequest[] = [];
  public fail = false;
  public async snapshot(request: ClosureCostsRequest): Promise<void> {
    if (this.fail) throw new Error('cost snapshot failed');
    this.taken.push(request);
  }
}
export class FakeSettings implements WorkflowSettings {
  public photo: ReportPhotoMode = 'photo_or_justification';
  public threshold: CostThreshold | null = null;
  public fail = false;
  public async reportPhoto(): Promise<ReportPhotoMode> {
    return this.photo;
  }
  public async closeCostThreshold(): Promise<CostThreshold | null> {
    if (this.fail) throw new Error('settings unavailable');
    return this.threshold;
  }
}
export class FakeMembers implements ResponsibleDirectory {
  /** `tenant/member` to permissions. */
  public members = new Map<string, readonly string[]>([
    [`${TENANT_A}/${MANAGER.subject}`, ['incidents:view', 'incidents:edit']],
    [`${TENANT_A}/only-generic`, ['view', 'edit', 'incidents:view']],
    ['tenant-b/member-b', ['incidents:view', 'incidents:edit']],
  ]);
  public async permissionsOf(tenantId: string, memberId: string) {
    return this.members.get(`${tenantId}/${memberId}`) ?? null;
  }
}

/** The workflow over the in-memory store of the cases and the fixtures above. */
export function setup(now: () => Date = () => NOW) {
  const store = new InMemoryIncidentStore();
  const refs = new FakeReferences();
  // One policy covers the day of COMPLETE, so a case is `covered` unless a test changes that.
  refs.revisions = [revision('pol-1', 1, '2026-01-01', '2026-12-31')];
  const evidence = new FakeEvidence();
  const repairs = new FakeRepairs();
  const costs = new FakeCosts();
  const settings = new FakeSettings();
  const members = new FakeMembers();
  const blocks = new FakeBlocks();
  const closures = new InMemoryIncidentClosures();
  const closureCosts = new FakeClosureCosts();
  let n = 0;
  const cases = new IncidentService(store, refs, { now, newId: () => `incident-${++n}` });
  const ports: WorkflowPorts = {
    references: refs,
    evidence,
    settings,
    members,
    repairs,
    costs,
    totals: costs,
    blocks,
    closures,
    closureCosts,
  };
  const workflow = new IncidentWorkflowService(store, ports, { now });
  const process = new IncidentProcessService(store, ports, { now });
  const failClosed = new IncidentWorkflowService(
    store,
    {
      ...ports,
      repairs: FAIL_CLOSED_REPAIRS,
      costs: FAIL_CLOSED_COSTS,
      totals: FAIL_CLOSED_TOTALS,
    },
    { now },
  );
  return {
    store,
    refs,
    evidence,
    repairs,
    costs,
    settings,
    members,
    blocks,
    closures,
    closureCosts,
    cases,
    workflow,
    process,
    failClosed,
    ports,
  };
}
export type World = ReturnType<typeof setup>;

/** Data that satisfies every requirement of every command, written straight to the case. */
export const FULL: Partial<Incident> = {
  responsibleId: `user-${MANAGER.subject}`,
  insurerName: 'Aseguradora Sintética',
  claimNumber: 'REP-0001',
  insurerReportedOn: '2026-10-13',
  insurerResult: 'accepted',
  rejectionReason: 'Motivo de rechazo sintético',
  appealNote: 'Apelación sintética',
  noInsuranceReason: 'Decisión sintética sin aseguradora',
  costAssumed: true,
  resolutionSummary: 'Resolución sintética',
  vehicleStatusDecision: 'active',
};

/** Writes fixture data to a case as the store would after a command, so a test can start from any state. */
export async function put(
  world: World,
  incident: Incident,
  patch: Partial<Incident>,
  transitions: readonly NewIncidentTransition[] = [],
): Promise<Incident> {
  const current = (await world.store.get(incident.tenantId, incident.id)) as Incident;
  const result = await world.store.apply({
    incident: { ...current, ...patch, version: current.version + 1 },
    expectedVersion: current.version,
    folioYear: null,
    transitions,
    auditActions: [],
    events: [],
  });
  if (!result.applied) throw new Error('fixture write refused');
  return result.incident;
}

/** A complete draft of the manager in the tenant, ready to be reported. */
export async function draft(world: World, overrides: Record<string, unknown> = {}) {
  return world.cases.create(TENANT_A, MANAGER, { ...COMPLETE, ...overrides });
}

/** Lets a test read the case as the store has it. */
export async function reload(world: World, incident: Incident): Promise<Incident> {
  return (await world.store.get(incident.tenantId, incident.id)) as Incident;
}
export type { Incident, IncidentActor };

/** A `resolve` entry in the timeline, so a case put in `resolved` has the route the closure revalidates. */
export const resolvedFrom = (origin: Incident['status']): NewIncidentTransition => ({
  command: 'resolve',
  from: origin,
  to: 'resolved',
  actorId: ADMIN.id,
  comment: null,
  occurredAt: NOW.toISOString(),
  changedFields: ['resolvedAt', 'status'],
  before: null,
});
