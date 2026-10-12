import { randomUUID } from 'node:crypto';
import {
  WorkOrderService,
  type WorkOrderActor,
  type WorkOrderReferences,
} from '../../../packages/domain/maintenance/orders/src/index.js';
import type { MaintenancePlan } from '../../../packages/domain/maintenance/plans/src/index.js';
import { TypeOrmMaintenancePlanStore } from '../../../packages/persistence/maintenance/plans/src/index.js';
import { TypeOrmWorkOrderStore } from '../../../packages/persistence/maintenance/orders/src/index.js';
import {
  adminUrl,
  startWorkOrderDatabase,
  type WorkOrderTestDatabase,
} from '../../../packages/persistence/maintenance/orders/src/test-support/mysql.js';

export { adminUrl };
type DataSource = Awaited<ReturnType<WorkOrderTestDatabase['openOrders']>>;

/** Synthetic actors of SPECS §5.4 / D9; permissions mirror the composition's grants. */
export const ACTORS = {
  admin: {
    id: 'user-admin',
    subject: 'admin',
    permissions: ['view', 'create', 'edit', 'view_costs', 'incidents:approve', 'reopen'],
    mechanicIds: [],
  },
  editor: {
    id: 'user-editor',
    subject: 'editor',
    permissions: ['view', 'create', 'edit'],
    mechanicIds: [],
  },
  supervisor: {
    id: 'user-supervisor',
    subject: 'supervisor',
    permissions: ['view', 'incidents:approve'],
    mechanicIds: [],
  },
  viewer: { id: 'user-viewer', subject: 'viewer', permissions: ['view'], mechanicIds: [] },
  mechanic: {
    id: 'user-mech',
    subject: 'mech',
    permissions: ['view'],
    mechanicIds: ['mechanic-a'],
  },
} satisfies Record<string, WorkOrderActor>;

export const VEHICLE = 'synthetic-vehicle-a';
export const at = (iso: string) => new Date(iso);

export interface MaintenanceWorld {
  readonly db: WorkOrderTestDatabase;
  readonly plansA: TypeOrmMaintenancePlanStore;
  readonly plansA2: TypeOrmMaintenancePlanStore;
  readonly plansB: TypeOrmMaintenancePlanStore;
  readonly ordersSourceA: DataSource;
  readonly ordersSourceA2: DataSource;
  readonly ordersSourceB: DataSource;
  readonly tenantA: string;
  readonly tenantB: string;
  /** A work order service over the real MySQL store of tenant database A (or B). */
  service(options?: {
    approval?: boolean;
    clock?: () => Date;
    side?: 'a' | 'a2' | 'b';
  }): WorkOrderService;
  plan(
    store: TypeOrmMaintenancePlanStore,
    tenantId: string,
    values: Partial<MaintenancePlan>,
  ): Promise<MaintenancePlan>;
  close(): Promise<void>;
}

/** Two tenant-exclusive MySQL 8.4 databases (A, B) with MNT-PLANS and MNT-ORDERS migrations. */
export async function startMaintenanceWorld(tag: string): Promise<MaintenanceWorld> {
  const db = await startWorkOrderDatabase(tag);
  const [plansSourceA, plansSourceA2, plansSourceB, ordersSourceA, ordersSourceA2, ordersSourceB] =
    await Promise.all([
      db.openPlans('a'),
      db.openPlans('a'),
      db.openPlans('b'),
      db.openOrders('a'),
      db.openOrders('a'),
      db.openOrders('b'),
    ]);
  const plansA = new TypeOrmMaintenancePlanStore(plansSourceA);
  const plansA2 = new TypeOrmMaintenancePlanStore(plansSourceA2);
  const plansB = new TypeOrmMaintenancePlanStore(plansSourceB);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  for (const [tenant, mechanic] of [
    [tenantA, 'mechanic-a'],
    [tenantB, 'mechanic-b'],
  ] as const) {
    const run = tenant === tenantA ? db.rows.bind(db) : db.rowsB.bind(db);
    await run(
      `INSERT INTO opslog_maintenance_workshops (company_id,id,name,specialties,contact,active,created_at,updated_at) VALUES (?, 'workshop-1', 'Taller sintético', JSON_ARRAY(), NULL, TRUE, NOW(6), NOW(6))`,
      [tenant],
    );
    await run(
      `INSERT INTO opslog_maintenance_mechanics (company_id,id,name,specialties,contact,kind,workshop_id,member_id,registered_by,active,created_at,updated_at) VALUES (?, ?, 'Mecánico sintético', JSON_ARRAY(), NULL, 'internal', 'workshop-1', 'mech', 'user-admin', TRUE, NOW(6), NOW(6))`,
      [tenant, mechanic],
    );
  }
  const refs = (
    tenantPlans: TypeOrmMaintenancePlanStore,
    approval: boolean,
  ): WorkOrderReferences => ({
    vehicleExists: async (_tenant, vehicleId) => vehicleId === VEHICLE,
    isTenantMember: async (_tenant, memberId) => ['admin', 'editor', 'mech'].includes(memberId),
    workshop: async (_tenant, id) => (id === 'workshop-1' ? { active: true } : null),
    mechanic: async (tenantId, id) =>
      (tenantId === tenantA && id === 'mechanic-a') || (tenantId === tenantB && id === 'mechanic-b')
        ? { active: true, workshopId: 'workshop-1', memberId: 'mech' }
        : null,
    mechanicIdsOfMember: async () => [],
    scheduledOrder: async (tenantId, planId, orderId) => {
      const found = (await tenantPlans.listScheduledOrders(tenantId, planId).catch(() => [])).find(
        (order) => order.id === orderId,
      );
      return found
        ? {
            id: found.id,
            occurrenceId: found.occurrenceId,
            planId: found.planId,
            vehicleId: found.vehicleId,
            status: found.status,
            workshopId: (found.snapshot['workshopId'] as string | null) ?? null,
            mechanicId: (found.snapshot['mechanicId'] as string | null) ?? null,
          }
        : null;
    },
    planBaseline: async (tenantId, planId, occurrenceId) => {
      if (occurrenceId !== null)
        return tenantPlans.baselineBeforeClosure(tenantId, planId, occurrenceId);
      const plan = await tenantPlans.get(tenantId, planId);
      return plan
        ? {
            lastServiceDate: plan.lastServiceDate ?? null,
            lastServiceKm: plan.lastServiceKm ?? null,
          }
        : null;
    },
    closeApprovalRequired: async () => approval,
  });
  return {
    db,
    plansA,
    plansA2,
    plansB,
    ordersSourceA,
    ordersSourceA2,
    ordersSourceB,
    tenantA,
    tenantB,
    service({ approval = false, clock = () => at('2026-10-12T12:00:00.000Z'), side = 'a' } = {}) {
      const source = side === 'a' ? ordersSourceA : side === 'a2' ? ordersSourceA2 : ordersSourceB;
      return new WorkOrderService(
        new TypeOrmWorkOrderStore(source),
        refs(side === 'b' ? plansB : plansA, approval),
        {
          now: clock,
        },
      );
    },
    async plan(store, tenantId, values) {
      const now = '2026-10-01T00:00:00.000Z';
      const plan: MaintenancePlan = {
        tenantId,
        id: randomUUID(),
        vehicleId: VEHICLE,
        state: 'active',
        version: 1,
        createdAt: now,
        updatedAt: now,
        ...values,
      };
      return store.create(plan, 'user-admin');
    },
    close: () => db.close(),
  };
}
