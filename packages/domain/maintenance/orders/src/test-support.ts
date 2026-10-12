import { InMemoryWorkOrderStore } from './store.js';
import { WorkOrderService } from './service.js';
import type { PlanScheduledOrderRef, WorkOrderFileRecord, WorkOrderReferences } from './types.js';
import type { WorkOrderActor } from './workflow.js';

export const TENANT = 'tenant-a';
export const FLEET: WorkOrderActor = {
  id: 'user-fleet',
  subject: 'fleet',
  permissions: ['view', 'create', 'edit', 'view_costs'],
  mechanicIds: [],
};
export const ADMIN: WorkOrderActor = {
  id: 'user-admin',
  subject: 'admin',
  permissions: ['view', 'create', 'edit', 'view_costs', 'incidents:approve', 'reopen'],
  mechanicIds: [],
};
export const EDITOR: WorkOrderActor = {
  id: 'user-editor',
  subject: 'editor',
  permissions: ['view', 'create', 'edit'],
  mechanicIds: [],
};
export const VIEWER: WorkOrderActor = {
  id: 'user-viewer',
  subject: 'viewer',
  permissions: ['view'],
  mechanicIds: [],
};
export const MECHANIC: WorkOrderActor = {
  id: 'user-mech',
  subject: 'mech',
  permissions: ['view'],
  mechanicIds: ['mechanic-1'],
};
export const OTHER_MECHANIC: WorkOrderActor = {
  id: 'user-mech2',
  subject: 'mech2',
  permissions: ['view'],
  mechanicIds: ['mechanic-2'],
};

export interface Harness {
  readonly store: InMemoryWorkOrderStore;
  readonly service: WorkOrderService;
  readonly refs: WorkOrderReferences & {
    approval: boolean;
    scheduled: PlanScheduledOrderRef[];
    zone: string;
    required: { evidence: boolean; invoice: boolean };
    files: Map<string, WorkOrderFileRecord>;
  };
  readonly clock: { now: Date };
}

/** Deterministic world: one vehicle, two members, one workshop and two mechanics of tenant A. */
export function harness(): Harness {
  const store = new InMemoryWorkOrderStore();
  const clock = { now: new Date('2026-10-12T12:00:00.000Z') };
  let sequence = 0;
  const refs = {
    approval: false,
    zone: 'UTC',
    required: { evidence: false, invoice: false },
    files: new Map<string, WorkOrderFileRecord>(),
    scheduled: [] as PlanScheduledOrderRef[],
    vehicleExists: async (tenantId: string, vehicleId: string) =>
      tenantId === TENANT && vehicleId === 'vehicle-1',
    isTenantMember: async (tenantId: string, memberId: string) =>
      tenantId === TENANT && ['fleet', 'mech'].includes(memberId),
    workshop: async (tenantId: string, id: string) =>
      tenantId === TENANT && id === 'workshop-1'
        ? { active: true }
        : tenantId === TENANT && id === 'workshop-off'
          ? { active: false }
          : null,
    mechanic: async (tenantId: string, id: string) =>
      tenantId !== TENANT
        ? null
        : id === 'mechanic-1'
          ? { active: true, workshopId: 'workshop-1', memberId: 'mech' }
          : id === 'mechanic-2'
            ? { active: true, workshopId: 'workshop-2', memberId: 'mech2' }
            : null,
    mechanicIdsOfMember: async () => [],
    scheduledOrder: async (tenantId: string, planId: string, orderId: string) =>
      tenantId === TENANT
        ? (refs.scheduled.find((order) => order.planId === planId && order.id === orderId) ?? null)
        : null,
    planBaseline: async (tenantId: string, planId: string) =>
      tenantId === TENANT && planId === 'plan-1'
        ? { lastServiceDate: '2026-09-01', lastServiceKm: 1000 }
        : null,
    closeApprovalRequired: async () => refs.approval,
    timeZone: async () => refs.zone,
    fileRequirements: async () => refs.required,
    fileRecord: async (tenantId: string, fileId: string) =>
      tenantId === TENANT ? (refs.files.get(fileId) ?? null) : null,
  };
  const service = new WorkOrderService(store, refs, {
    now: () => clock.now,
    newId: () => `id-${(sequence += 1)}`,
  });
  return { store, service, refs, clock };
}
