import type {
  ApiError,
  BffMaintenanceMechanic,
  BffMaintenancePlan,
  BffMaintenanceWorkshop,
  BffWorkOrder,
  BffWorkOrderTransition,
  BffWorkOrderTransitionInput,
} from '@opslog/contracts';
import type { MaintenancePorts, Result } from './ports';

/**
 * In-memory stand-in for the accepted MNT-PLANS/MNT-ORDERS routes, for component tests and stories
 * only. It mimics the server's answers (sanitized costs, 409, 422 lists); it is not a rule source.
 */
export interface FakeMaintenanceOptions {
  readonly viewCosts?: boolean | (() => boolean);
  /** When set, the caller only sees orders assigned to these mechanics (server-side scope). */
  readonly scopedTo?: readonly string[] | (() => readonly string[] | undefined);
  readonly orders?: readonly BffWorkOrder[];
  readonly plans?: readonly BffMaintenancePlan[];
  readonly workshops?: readonly BffMaintenanceWorkshop[];
  readonly mechanics?: readonly BffMaintenanceMechanic[];
  readonly failLists?: boolean;
}

const at = '2026-10-12T12:00:00.000Z';
const fail = (
  status: ApiError['status'],
  code: string,
  missingRequirements?: string[],
): Result<never> => ({
  ok: false,
  error: {
    status,
    code,
    message: 'x',
    correlationId: 'fake',
    ...(missingRequirements ? { missingRequirements } : {}),
  },
});
const ok = <T>(value: T): Result<T> => ({ ok: true, value: structuredClone(value) });
const omit = <T extends object>(value: T, key: string): T =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)) as T;

export function baseOrder(overrides: Partial<BffWorkOrder> = {}): BffWorkOrder {
  return {
    id: 'wo-1',
    kind: 'corrective',
    vehicleId: 'veh-001',
    planId: null,
    occurrenceId: null,
    status: 'scheduled',
    version: 1,
    description: 'Frenos rechinan',
    responsibleId: null,
    workshopId: null,
    mechanicId: null,
    scheduledDate: null,
    requiresWorkshop: false,
    startedAt: null,
    completedAt: null,
    actualDate: null,
    actualKm: null,
    tasks: [],
    parts: [],
    costs: [],
    closeApproval: null,
    closedAt: null,
    closedBy: null,
    vehicleStatusDecision: null,
    cancelReason: null,
    reopenCount: 0,
    vehicleProposal: null,
    createdAt: at,
    createdBy: 'user-admin',
    updatedAt: at,
    updatedBy: 'user-admin',
    ...overrides,
  };
}

const NEXT: Record<string, BffWorkOrder['status']> = {
  assign: 'assigned',
  start: 'in_progress',
  complete: 'completed',
  close: 'closed',
  cancel: 'cancelled',
  reopen: 'in_progress',
  approve_close: 'completed',
};

function missingFor(
  order: BffWorkOrder,
  input: BffWorkOrderTransitionInput,
  approvalRequired: boolean,
) {
  const checks: Record<string, Record<string, boolean>> = {
    assign: {
      responsibleId: Boolean(input.responsibleId),
      scheduledDate: Boolean(input.scheduledDate),
      workshopOrMechanic: Boolean(input.workshopId ?? input.mechanicId),
    },
    complete: {
      actualDate: Boolean(input.actualDate),
      actualKm: input.actualKm !== undefined,
      tasks: order.tasks.length > 0,
    },
    close: {
      tasks: order.tasks.length > 0,
      vehicleStatus: Boolean(input.vehicleStatus),
      closeApproval: !approvalRequired || order.closeApproval !== null,
    },
    cancel: { reason: Boolean(input.reason) },
    reopen: { reason: Boolean(input.reason) },
  };
  return Object.entries(checks[input.command] ?? {})
    .filter(([, present]) => !present)
    .map(([name]) => name);
}

export function createFakeMaintenancePorts(options: FakeMaintenanceOptions = {}) {
  const orders = new Map((options.orders ?? [baseOrder()]).map((o) => [o.id, structuredClone(o)]));
  const history = new Map<string, BffWorkOrderTransition[]>();
  const plans = [...(options.plans ?? [])];
  const workshops = [...(options.workshops ?? [])];
  const mechanics = [...(options.mechanics ?? [])];
  const state = { approvalRequired: false, calls: [] as string[] };
  const viewCosts = () =>
    typeof options.viewCosts === 'function' ? options.viewCosts() : Boolean(options.viewCosts);
  const scope = () =>
    typeof options.scopedTo === 'function' ? options.scopedTo() : options.scopedTo;
  const visible = (order: BffWorkOrder) =>
    !scope() ||
    (order.mechanicId !== null && (scope() as readonly string[]).includes(order.mechanicId));
  const sanitize = (order: BffWorkOrder): BffWorkOrder => {
    if (viewCosts()) return order;
    return { ...omit(order, 'costs'), parts: order.parts.map((part) => omit(part, 'unitCost')) };
  };
  const find = (id: string) => {
    const order = orders.get(id);
    return order && visible(order) ? order : undefined;
  };
  const save = (
    order: BffWorkOrder,
    command: BffWorkOrderTransition['command'],
    from: BffWorkOrder['status'] | null,
    comment: string | null,
  ) => {
    orders.set(order.id, order);
    const entries = history.get(order.id) ?? [];
    entries.push({
      orderId: order.id,
      sequence: order.version,
      command,
      from,
      to: order.status,
      actorId: 'user-admin',
      comment,
      occurredAt: at,
      before: null,
    });
    history.set(order.id, entries);
    return ok(sanitize(order));
  };
  const ports: MaintenancePorts = {
    orders: {
      list: async () =>
        options.failLists
          ? fail(500, 'internal_error')
          : ok([...orders.values()].filter(visible).map(sanitize)),
      get: async (id) => {
        const order = find(id);
        return order ? ok(sanitize(order)) : fail(404, 'not_found');
      },
      history: async (id) => (find(id) ? ok(history.get(id) ?? []) : fail(404, 'not_found')),
      createCorrective: async (body) => {
        const order = baseOrder({
          id: `wo-${orders.size + 1}`,
          vehicleId: body.vehicleId,
          description: body.description,
        });
        return save(order, 'create', null, null);
      },
      adoptPreventive: async () => fail(404, 'not_found'),
      transition: async (id, input) => {
        state.calls.push(`transition:${input.command}`);
        const order = find(id);
        if (!order) return fail(404, 'not_found');
        if (order.version !== input.version) return fail(409, 'stale_version');
        const missing = missingFor(order, input, state.approvalRequired);
        if (missing.length) return fail(422, 'missing_requirements', missing);
        const status = NEXT[input.command] as BffWorkOrder['status'];
        const next: BffWorkOrder = {
          ...order,
          status,
          version: order.version + 1,
          ...(input.command === 'assign'
            ? {
                responsibleId: input.responsibleId ?? null,
                workshopId: input.workshopId ?? null,
                mechanicId: input.mechanicId ?? null,
                scheduledDate: input.scheduledDate ?? null,
              }
            : {}),
          ...(input.command === 'start'
            ? {
                requiresWorkshop: input.requiresWorkshop ?? order.workshopId !== null,
                startedAt: at,
              }
            : {}),
          ...(input.command === 'complete'
            ? {
                actualDate: input.actualDate ?? null,
                actualKm: input.actualKm ?? null,
                completedAt: at,
              }
            : {}),
          ...(input.command === 'approve_close'
            ? { closeApproval: { approvedBy: 'user-admin', approvedAt: at } }
            : {}),
          ...(input.command === 'close'
            ? {
                closedAt: at,
                closedBy: 'user-admin',
                vehicleStatusDecision: input.vehicleStatus ?? null,
              }
            : {}),
          ...(input.command === 'cancel' ? { cancelReason: input.reason ?? null } : {}),
          ...(input.command === 'reopen'
            ? {
                closedAt: null,
                closedBy: null,
                closeApproval: null,
                reopenCount: order.reopenCount + 1,
              }
            : {}),
        };
        const proposal = next.requiresWorkshop && status === 'in_progress';
        return save(
          {
            ...next,
            vehicleProposal: proposal
              ? { suggestedStatus: 'in_maintenance', eligibilityBlocked: true }
              : null,
          },
          input.command,
          order.status,
          input.reason ?? input.comment ?? null,
        );
      },
      recordWork: async (id, body) => {
        const order = find(id);
        if (!order) return fail(404, 'not_found');
        if (order.version !== body.version) return fail(409, 'stale_version');
        const tasks = (body.tasks ?? []).map((t, i) => ({
          id: t.id ?? `task-${order.version}-${i}`,
          description: t.description,
        }));
        const parts = (body.parts ?? []).map((p, i) => ({
          id: p.id ?? `part-${order.version}-${i}`,
          name: p.name,
          quantity: p.quantity,
          unitCost: order.parts.find((x) => x.id === p.id)?.unitCost ?? null,
        }));
        orders.set(id, { ...order, tasks, parts, version: order.version + 1 });
        return ok(sanitize(orders.get(id) as BffWorkOrder));
      },
      recordCosts: async (id, body) => {
        const order = find(id);
        if (!order) return fail(404, 'not_found');
        if (!viewCosts()) return fail(403, 'forbidden');
        if (order.version !== body.version) return fail(409, 'stale_version');
        const costs = (body.costs ?? []).map((c, i) => ({
          id: c.id ?? `cost-${order.version}-${i}`,
          category: c.category,
          amount: c.amount,
        }));
        orders.set(id, { ...order, costs, version: order.version + 1 });
        return ok(orders.get(id) as BffWorkOrder);
      },
    },
    plans: {
      list: async () => (options.failLists ? fail(500, 'internal_error') : ok(plans)),
      create: async (body) => {
        const plan: BffMaintenancePlan = {
          id: `plan-${plans.length + 1}`,
          state: 'active',
          version: 1,
          createdAt: at,
          updatedAt: at,
          defaultWorkshopId: null,
          defaultMechanicId: null,
          ...body,
        };
        plans.push(plan);
        return ok(plan);
      },
      update: async (id, body) => {
        const index = plans.findIndex((p) => p.id === id);
        const current = plans[index];
        if (!current) return fail(404, 'not_found');
        if (current.version !== body.version) return fail(409, 'stale_version');
        const next = {
          ...current,
          ...omit(body, 'version'),
          version: current.version + 1,
        } as BffMaintenancePlan;
        plans[index] = next;
        return ok(next);
      },
      schedule: async (id) =>
        plans.some((p) => p.id === id)
          ? ok({
              planId: id,
              nextTargetDate: '2026-11-01',
              nextTargetKm: 15000,
              occurrence: null,
              order: null,
            })
          : fail(404, 'not_found'),
    },
    workshops: {
      list: async () => ok(workshops),
      create: async (body) => {
        const workshop = {
          id: `ws-${workshops.length + 1}`,
          contact: null,
          active: true,
          createdAt: at,
          updatedAt: at,
          ...body,
        };
        workshops.push(workshop);
        return ok(workshop);
      },
      deactivate: async (id) => {
        const workshop = workshops.find((w) => w.id === id);
        if (!workshop) return fail(404, 'not_found');
        Object.assign(workshop, { active: false });
        return ok(workshop);
      },
    },
    mechanics: {
      list: async () => ok(mechanics),
      create: async (body) => {
        const mechanic = {
          id: `mec-${mechanics.length + 1}`,
          contact: null,
          workshopId: null,
          memberId: null,
          active: true,
          createdAt: at,
          updatedAt: at,
          ...body,
        };
        mechanics.push(mechanic);
        return ok(mechanic);
      },
      deactivate: async (id) => {
        const mechanic = mechanics.find((m) => m.id === id);
        if (!mechanic) return fail(404, 'not_found');
        Object.assign(mechanic, { active: false });
        return ok(mechanic);
      },
    },
  };
  return {
    ports,
    state,
    /** Simulates another person changing the order (next write gets 409). */
    bump(id: string) {
      const order = orders.get(id);
      if (order) orders.set(id, { ...order, version: order.version + 1 });
    },
  };
}
