import {
  CostLedger,
  IncidentCostService,
  type IncidentCostStore,
  type PolicyDeductible,
  type PolicyDeductibles,
} from '../../../../../packages/domain/incidents/costs/src/index.js';
import {
  LinkedRepairs,
  RepairLinkService,
  type IncidentRepairStore,
  type RepairOrderReader,
} from '../../../../../packages/domain/incidents/repairs/src/index.js';
import type { IncidentStore } from '../../../../../packages/domain/incidents/cases/src/index.js';
import type { IncidentEvidenceFacts } from '../../../../../packages/domain/incidents/workflow/src/index.js';
import { InMemoryWorkOrderStore } from '../../../../../packages/domain/maintenance/orders/src/index.js';
import { InMemoryWorkshopStore } from '../../../../../packages/domain/maintenance/workshops/src/index.js';
import { InMemoryMechanicStore } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import { IncidentCostApi } from '../../../incidents/costs/src/index.js';
import { IncidentRepairApi } from '../../../incidents/repairs/src/index.js';
import { ROLE_LABELS } from '../directory.js';
import { UNKNOWN_MEMBER_LABEL, type IncidentServices } from './incident-apis.js';
import type { PlatformKernel } from './kernel.js';
import { createMechanicScope } from './mechanic-scope.js';
import type { PlatformAdapters } from './types.js';

const PAGE = 100;

/**
 * The workshop's orders as the incidents read them: through the order store port of the tenant, never
 * through tables, so the incidents runtime has no grant on maintenance (INC-COSTS invariant 8).
 */
export function repairOrderReader(adapters: PlatformAdapters): RepairOrderReader {
  const orders = adapters.maintenanceOrders ?? new InMemoryWorkOrderStore();
  const workshops = adapters.maintenanceWorkshops ?? new InMemoryWorkshopStore();
  return {
    order: async (tenantId, orderId) => {
      const order = await orders.get(tenantId, orderId);
      if (!order) return null;
      const workshop = order.workshopId ? await workshops.get(tenantId, order.workshopId) : null;
      return {
        id: order.id,
        vehicleId: order.vehicleId,
        kind: order.kind,
        status: order.status,
        version: order.version,
        description: order.description,
        workshopName: workshop?.name ?? null,
        costs: order.costs.map((cost) => cost.amount),
      };
    },
  };
}

/** The deductible of the policy revision that covered the event, as insurance keeps it. */
export function policyDeductibles(services: IncidentServices): PolicyDeductibles {
  return {
    deductible: async (tenantId, policyId, revision): Promise<PolicyDeductible | null> => {
      for (let offset = 0; ; offset += PAGE) {
        const page = await services.policies.revisions(tenantId, policyId, {
          limit: PAGE,
          offset,
        });
        const found = page.items.find((row) => row.revision === revision);
        if (found) {
          const { deductible } = found;
          if (!deductible) return null;
          return deductible.kind === 'amount'
            ? {
                kind: 'amount',
                amountMinor: String(deductible.amountMinor),
                currency: deductible.currency,
              }
            : { kind: 'percent', basisPoints: deductible.basisPoints };
        }
        if (offset + PAGE >= page.total || page.items.length === 0) return null;
      }
    },
  };
}

/** The ports INC-WORKFLOW leaves open, over the links, the cost lines and the order reader. */
export function costPorts(
  repairs: IncidentRepairStore,
  costs: IncidentCostStore,
  orders: RepairOrderReader,
) {
  const ledger = new CostLedger(costs, repairs, orders);
  return {
    ledger,
    repairs: new LinkedRepairs(repairs, orders),
    costs: ledger,
    totals: ledger,
    closureCosts: ledger,
  };
}

/** Repair links and costs of the incidents over the shared stores, the order reader and the policy port. */
export function buildIncidentCostApis(
  kernel: PlatformKernel,
  adapters: PlatformAdapters,
  services: IncidentServices,
  stores: {
    readonly store: IncidentStore;
    readonly repairs: IncidentRepairStore;
    readonly costs: IncidentCostStore;
  },
  orders: RepairOrderReader,
  evidence: IncidentEvidenceFacts,
  ledger: CostLedger,
): { readonly incidentRepairs: IncidentRepairApi; readonly incidentCosts: IncidentCostApi } {
  const scope = createMechanicScope(adapters.maintenanceMechanics ?? new InMemoryMechanicStore());
  const options = { now: kernel.now };
  const session = {
    authorize: async (token: string, correlationId: string) => {
      const context = await kernel.authorize(token, correlationId, []);
      return { context, permissions: await kernel.access.resolvePermissions(context) };
    },
    mechanicLinked: scope.mechanicLinked,
    // A refused access is audited like any other denied attempt; the audit trail has no payload.
    deny: (
      context: Parameters<typeof kernel.userActor>[0],
      action: string,
      entityId: string,
      correlationId: string,
    ) => kernel.auditNow(kernel.userActor(context), action, 'incident', entityId, correlationId),
  };
  return {
    incidentRepairs: new IncidentRepairApi({
      ...session,
      repairs: new RepairLinkService(stores.store, stores.repairs, orders, evidence, options),
      labels: {
        member: async (tenantId, actorId) => {
          const role = await kernel.access.effectiveRole(tenantId, actorId.replace(/^user-/, ''));
          return role ? ROLE_LABELS[role] : UNKNOWN_MEMBER_LABEL;
        },
      },
    }),
    incidentCosts: new IncidentCostApi({
      ...session,
      costs: new IncidentCostService(
        stores.store,
        stores.costs,
        ledger,
        policyDeductibles(services),
        options,
      ),
    }),
  };
}
