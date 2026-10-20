import type { EmployeeFacts, IncidentFacts, PolicyFacts, VehicleFacts } from './entries.js';
import type { SearchSources, SourcePage } from './ports.js';

export const AT = '2026-10-19T12:00:00.000Z';

export const vehicle = (id: string, over: Partial<VehicleFacts> = {}): VehicleFacts => ({
  id,
  areaId: 'area-1',
  economicNumber: `E-${id}`,
  plate: 'ÁBC-123',
  vin: null,
  make: 'Nissan',
  model: 'NP300',
  archivedAt: null,
  updatedAt: AT,
  ...over,
});
export const employee = (id: string, over: Partial<EmployeeFacts> = {}): EmployeeFacts => ({
  id,
  kind: 'driver',
  areaId: 'area-1',
  firstName: 'Ana',
  lastName: 'Pérez',
  employeeNumber: `N-${id}`,
  nationalIdIndex: null,
  licenseIndex: null,
  archivedAt: null,
  updatedAt: AT,
  ...over,
});
export const incident = (id: string, over: Partial<IncidentFacts> = {}): IncidentFacts => ({
  id,
  areaId: 'area-1',
  folio: `SIN-2026-${id}`,
  claimNumber: null,
  updatedAt: AT,
  ...over,
});
export const policy = (id: string, over: Partial<PolicyFacts> = {}): PolicyFacts => ({
  id,
  policyNumber: `POL-${id}`,
  insurer: 'Qualitas',
  archivedAt: null,
  updatedAt: AT,
  ...over,
});

interface World {
  vehicles: VehicleFacts[];
  employees: EmployeeFacts[];
  incidents: IncidentFacts[];
  policies: PolicyFacts[];
}

/** Sources over plain arrays per company, paged like the real ports. */
export class FakeSources implements SearchSources {
  public readonly worlds = new Map<string, World>();
  public world(tenantId: string): World {
    let world = this.worlds.get(tenantId);
    if (!world) {
      world = { vehicles: [], employees: [], incidents: [], policies: [] };
      this.worlds.set(tenantId, world);
    }
    return world;
  }
  private page<T>(items: readonly T[], offset: number, limit: number): SourcePage<T> {
    return { items: items.slice(offset, offset + limit), total: items.length };
  }
  public async vehicles(tenantId: string, offset: number, limit: number) {
    return this.page(this.world(tenantId).vehicles, offset, limit);
  }
  public async employees(tenantId: string, offset: number, limit: number) {
    return this.page(this.world(tenantId).employees, offset, limit);
  }
  public async incidents(tenantId: string, offset: number, limit: number) {
    return this.page(this.world(tenantId).incidents, offset, limit);
  }
  public async policies(tenantId: string, offset: number, limit: number) {
    return this.page(this.world(tenantId).policies, offset, limit);
  }
}
