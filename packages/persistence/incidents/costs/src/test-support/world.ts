import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import {
  IncidentService,
  type IncidentActor,
  type IncidentReferences,
} from '../../../../../domain/incidents/cases/src/index.js';
import {
  CostLedger,
  IncidentCostService,
  type PolicyDeductibles,
} from '../../../../../domain/incidents/costs/src/index.js';
import {
  LinkedRepairs,
  RepairLinkService,
} from '../../../../../domain/incidents/repairs/src/index.js';
import { FakeOrders } from '../../../../../domain/incidents/repairs/src/test-support.js';
import {
  IncidentProcessService,
  IncidentWorkflowService,
  type CostThreshold,
  type WorkflowPorts,
} from '../../../../../domain/incidents/workflow/src/index.js';
import { TypeOrmIncidentClosures } from '../../../workflow/src/closures.js';
import { TypeOrmIncidentStore } from '../../../cases/src/store.js';
import { TypeOrmIncidentRepairStore } from '../../../repairs/src/store.js';
import { TypeOrmIncidentCostStore } from '../store.js';

export const actor = (permissions: string[]): IncidentActor => {
  const subject = randomUUID();
  return { id: `user-${subject}`, subject, permissions, mechanicLinked: false };
};
export const MANAGER = actor([
  'incidents:view',
  'incidents:create',
  'incidents:edit',
  'incidents:approve',
  'incidents:close',
  'incidents:reopen',
  'incidents:view_costs',
]);
export const NO_COSTS = actor(['incidents:view', 'incidents:edit']);
export const DRAFT = {
  vehicleId: 'vehicle-1',
  type: 'other',
  severity: 'low',
  occurredAt: '2026-10-13T12:00:00.000Z',
  location: { text: 'Calle Sintética' },
  description: 'Descripción sintética',
  vehicleOperable: true,
  noDriverReason: 'Vehículo estacionado',
  noPhotoJustification: 'Sin foto disponible',
};
const refs: IncidentReferences = {
  vehicle: async (_tenant, id) =>
    id === 'vehicle-1' ? { id, areaId: 'area-1', registeredOn: '2026-01-01' } : null,
  driver: async () => null,
  assignments: async () => [],
  policyRevisions: async () => [],
  timeZone: async () => 'UTC',
};
export const NOW = new Date('2026-10-13T18:00:00.000Z');

/** The workshop and the company settings are shared by every connection of a test. */
export class Shared {
  public readonly orders = new FakeOrders();
  public threshold: CostThreshold | null = null;
  public readonly deductibles: PolicyDeductibles = { deductible: async () => null };
}

/** The incidents module over one real connection: real stores, real ports of INC-COSTS. */
export function incidentWorld(source: DataSource, shared: Shared) {
  const store = new TypeOrmIncidentStore(source);
  const repairs = new TypeOrmIncidentRepairStore(source, store);
  const costs = new TypeOrmIncidentCostStore(source, store);
  const options = { now: () => NOW };
  const ledger = new CostLedger(costs, repairs, shared.orders);
  const ports: WorkflowPorts = {
    references: refs,
    evidence: { evidence: async () => [] },
    settings: {
      reportPhoto: async () => 'photo_or_justification',
      closeCostThreshold: async () => shared.threshold,
    },
    members: { permissionsOf: async () => ['incidents:view', 'incidents:edit'] },
    repairs: new LinkedRepairs(repairs, shared.orders),
    costs: ledger,
    totals: ledger,
    blocks: { blocked: async () => false },
    closures: new TypeOrmIncidentClosures(source),
    closureCosts: ledger,
  };
  return {
    store,
    repairs,
    ledger,
    incidents: new IncidentService(store, refs, options),
    workflow: new IncidentWorkflowService(store, ports, options),
    process: new IncidentProcessService(store, ports, options),
    links: new RepairLinkService(
      store,
      repairs,
      shared.orders,
      { evidence: async () => [] },
      options,
    ),
    costs,
    costService: new IncidentCostService(store, costs, ledger, shared.deductibles, options),
  };
}
