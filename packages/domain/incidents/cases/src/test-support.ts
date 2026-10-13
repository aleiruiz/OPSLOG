import type { IncidentActor } from './access.js';
import type {
  AssignmentRef,
  DriverRef,
  IncidentReferences,
  PolicyRevisionRef,
  VehicleRef,
} from './ports.js';
import { IncidentService } from './service.js';
import { InMemoryIncidentStore } from './store.js';

export const TENANT_A = 'tenant-a';
export const TENANT_B = 'tenant-b';
export const VEHICLE = 'vehicle-1';
export const NOW = new Date('2026-10-13T18:00:00.000Z');

export const actorOf = (
  id: string,
  permissions: readonly string[],
  linked = false,
): IncidentActor => ({
  id: `user-${id}`,
  subject: id,
  permissions,
  mechanicLinked: linked,
});
export const MANAGER = actorOf('00000000-0000-4000-8000-000000000001', [
  'view',
  'incidents:view',
  'incidents:create',
  'incidents:edit',
  'incidents:report',
]);
export const REPORTER = actorOf('00000000-0000-4000-8000-000000000002', [
  'incidents:view',
  'incidents:report',
]);
export const OTHER_REPORTER = actorOf('00000000-0000-4000-8000-000000000003', [
  'incidents:view',
  'incidents:report',
]);

/** Mutable fixtures behind the references port; every list is keyed by tenant to prove isolation. */
export class FakeReferences implements IncidentReferences {
  public vehicles = new Map<string, VehicleRef>([
    [`${TENANT_A}/${VEHICLE}`, { id: VEHICLE, areaId: 'area-1', registeredOn: '2026-01-10' }],
    [`${TENANT_A}/vehicle-2`, { id: 'vehicle-2', areaId: 'area-2', registeredOn: '2026-01-10' }],
    [`${TENANT_B}/${VEHICLE}`, { id: VEHICLE, areaId: 'area-b', registeredOn: '2026-01-10' }],
  ]);
  public drivers = new Map<string, DriverRef>([
    [`${TENANT_A}/driver-1`, { id: 'driver-1', displayName: 'Ana Pérez' }],
    [`${TENANT_A}/driver-2`, { id: 'driver-2', displayName: 'Luis Gómez' }],
    [`${TENANT_B}/driver-b`, { id: 'driver-b', displayName: 'Beto B' }],
  ]);
  public assigned: AssignmentRef[] = [];
  public revisions: PolicyRevisionRef[] = [];
  public zones = new Map<string, string>([[TENANT_A, 'America/Mexico_City']]);

  public archived = new Set<string>();
  public async vehicle(tenantId: string, id: string, options?: { includeArchived?: boolean }) {
    if (this.archived.has(id) && options?.includeArchived !== true) return null;
    return this.vehicles.get(`${tenantId}/${id}`) ?? null;
  }
  public async driver(tenantId: string, id: string) {
    return this.drivers.get(`${tenantId}/${id}`) ?? null;
  }
  public async assignments(tenantId: string, vehicleId: string): Promise<readonly AssignmentRef[]> {
    return tenantId === TENANT_A && vehicleId === VEHICLE ? this.assigned : [];
  }
  public async policyRevisions(tenantId: string, vehicleId: string) {
    return tenantId === TENANT_A && vehicleId === VEHICLE ? this.revisions : [];
  }
  public async timeZone(tenantId: string) {
    return this.zones.get(tenantId) ?? 'UTC';
  }
}
export function revision(
  policyId: string,
  rev: number,
  startsOn: string,
  endsOn: string,
): PolicyRevisionRef {
  return {
    policyId,
    revision: rev,
    insurer: `Aseguradora ${policyId}`,
    policyNumber: `POL-${policyId}`,
    coverageType: 'comprehensive',
    startsOn,
    endsOn,
  };
}

export function setup(now: () => Date = () => NOW) {
  const store = new InMemoryIncidentStore();
  const refs = new FakeReferences();
  let n = 0;
  const service = new IncidentService(store, refs, {
    now,
    newId: () => `incident-${++n}`,
  });
  return { store, refs, service };
}
