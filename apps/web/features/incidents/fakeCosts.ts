import type {
  BffAlertSettings,
  BffCostLine,
  BffCurrencyTotals,
  BffIncident,
  BffIncidentAlert,
  BffIncidentCosts,
  BffMoney,
  BffRepairLink,
  BffWorkOrder,
} from '@opslog/contracts';
import { FAKE_NOW, ME } from './fakeIncident';
import { fail, ok, omit, type FakeContext, type Record_ } from './fakeContext';
import type { FakeIncidentOptions } from './fakePorts';
import type { IncidentPorts } from './ports';

/** A maintenance order as the stand-in module holds it; `costs` feed the totals of the case it is linked to. */
export interface FakeOrder {
  readonly id: string;
  readonly vehicleId: string;
  readonly description: string | null;
  readonly kind?: BffWorkOrder['kind'];
  readonly status?: BffWorkOrder['status'];
  readonly workshop?: string | null;
  readonly createdAt?: string;
  readonly costs?: readonly BffMoney[];
}

const toOrder = (order: FakeOrder): BffWorkOrder => ({
  id: order.id,
  kind: order.kind ?? 'corrective',
  vehicleId: order.vehicleId,
  planId: null,
  occurrenceId: null,
  status: order.status ?? 'scheduled',
  version: 1,
  description: order.description,
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
  closeApproval: null,
  closedAt: null,
  closedBy: null,
  vehicleStatusDecision: null,
  cancelReason: null,
  reopenCount: 0,
  vehicleProposal: null,
  createdAt: order.createdAt ?? FAKE_NOW,
  createdBy: 'user-me',
  updatedAt: FAKE_NOW,
  updatedBy: 'user-me',
});

/** The states where an order may be linked and the case's own costs may change (INC-COSTS). */
const COST_STATES: readonly BffIncident['status'][] = [
  'under_review',
  'insurance_process',
  'insurance_rejected',
  'no_insurance',
  'repair',
  'reopened',
];

const DEFAULT_SETTINGS: BffAlertSettings = {
  expiryWindowDays: 30,
  recipientRoles: ['admin', 'editor'],
  maintenanceEvidence: 'none',
  closeCostThreshold: null,
  timeZone: 'America/Mexico_City',
  incidentReportPhoto: 'photo_or_justification',
  incidentSlaDays: { critical: 7, high: 15, medium: 30, low: 45 },
  incidentInactivityDays: 5,
  version: 0,
  updatedBy: null,
  updatedAt: null,
};

const AMOUNT = /^[1-9]\d{0,14}$/;

/**
 * Repairs, costs, notices, orders and settings of the in-memory stand-in (component tests and the shell mock
 * only). The totals are real arithmetic over the lines and the linked orders' costs, per currency; the server
 * stays the authority for everything else.
 */
export function createFakeCosts(ctx: FakeContext, options: FakeIncidentOptions) {
  const orders = new Map<string, FakeOrder>((options.orders ?? []).map((o) => [o.id, o]));
  const alerts: BffIncidentAlert[] = [...(options.alerts ?? [])];
  const keyed = new Map<string, { body: string; result: unknown }>();
  let settings: BffAlertSettings = { ...DEFAULT_SETTINGS, ...options.settings };
  let sequence = 0;
  const has = (permission: string) => ctx.permissions().includes(permission);

  const totalsOf = (record: Record_): BffCurrencyTotals[] => {
    const sums = new Map<string, { repairs: bigint; expenses: bigint; recoveries: bigint }>();
    const bucket = (currency: string) => {
      const found = sums.get(currency) ?? { repairs: 0n, expenses: 0n, recoveries: 0n };
      sums.set(currency, found);
      return found;
    };
    for (const link of record.repairs)
      for (const cost of orders.get(link.orderId)?.costs ?? [])
        bucket(cost.currency).repairs += BigInt(cost.amountMinor);
    for (const line of record.costs.lines) {
      const total = bucket(line.amount.currency);
      if (line.kind === 'expense') total.expenses += BigInt(line.amount.amountMinor);
      else total.recoveries += BigInt(line.amount.amountMinor);
    }
    return [...sums.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, sum]) => ({
        currency,
        repairs: String(sum.repairs),
        expenses: String(sum.expenses),
        recoveries: String(sum.recoveries),
        companyBorne: String(sum.repairs + sum.expenses - sum.recoveries),
      }));
  };
  const costsOf = (record: Record_): BffIncidentCosts => {
    const totals = totalsOf(record);
    const last = record.costs.snapshots.at(-1);
    return {
      version: record.incident.version,
      lines: record.costs.lines,
      initialEstimate: record.costs.estimate,
      repairs: record.repairs.map((link) => {
        const byCurrency = new Map<string, bigint>();
        for (const cost of orders.get(link.orderId)?.costs ?? [])
          byCurrency.set(
            cost.currency,
            (byCurrency.get(cost.currency) ?? 0n) + BigInt(cost.amountMinor),
          );
        return {
          linkId: link.id,
          orderId: link.orderId,
          totals: [...byCurrency.entries()].map(([currency, sum]) => ({
            amountMinor: String(sum),
            currency,
          })),
        };
      }),
      totals,
      mixedCurrencies: totals.length > 1,
      policyDeductible: options.policyDeductible ?? null,
      snapshots: record.costs.snapshots,
      differsFromLastClosure:
        last !== undefined && JSON.stringify(last.totals) !== JSON.stringify(totals),
    };
  };
  const linkView = (link: Record_['repairs'][number]): BffRepairLink => {
    const order = orders.get(link.orderId);
    return {
      id: link.id,
      orderId: link.orderId,
      order: {
        id: link.orderId,
        description: order?.description ?? null,
        status: order?.status ?? 'scheduled',
        workshop: order?.workshop ?? null,
      },
      linkedAt: link.linkedAt,
      linkedBy: ME,
    };
  };
  /** Changes to links or lines clear the approvals that depended on the costs (INC-COSTS invariant 4). */
  const clearApprovals = (record: Record_) => ({
    insurance: { ...record.incident.insurance, assumptionApproval: null },
    resolution: { ...record.incident.resolution, closeApproval: null },
  });
  const editGate = (record: Record_): Result_ | null => {
    if (!has('incidents:edit')) return fail(403, 'forbidden');
    if (!COST_STATES.includes(record.incident.status)) return fail(409, 'invalid_transition');
    return null;
  };
  type Result_ = ReturnType<typeof fail>;

  const ports: Pick<IncidentPorts, 'repairs' | 'costs' | 'alerts' | 'orders' | 'settings'> = {
    repairs: {
      list: (id) => {
        const failed = ctx.injected('repairs.list');
        if (failed) return Promise.resolve(failed);
        const record = ctx.visible(id);
        return Promise.resolve(
          record
            ? ok({ items: record.repairs.map((link) => linkView(link)) })
            : fail(404, 'not_found'),
        );
      },
      link: (id, body, key) => {
        const failed = ctx.injected('repairs.link');
        if (failed) return Promise.resolve(failed);
        const record = ctx.visible(id);
        if (!record) return Promise.resolve(fail(404, 'not_found'));
        const signature = JSON.stringify([id, body]);
        const earlier = keyed.get(`link:${key}`);
        if (earlier)
          return Promise.resolve(
            earlier.body === signature
              ? ok(earlier.result as never)
              : fail(409, 'idempotency_conflict'),
          );
        const gate = editGate(record);
        if (gate) return Promise.resolve(gate);
        if (record.incident.version !== body.version)
          return Promise.resolve(fail(409, 'stale_version'));
        const order = orders.get(body.orderId);
        if (!order) return Promise.resolve(fail(404, 'not_found'));
        const rule = (field: string) =>
          fail(422, 'rule_violation', {
            fieldErrors: [{ field, code: 'invalid', message: 'x' }],
          });
        if (order.vehicleId !== record.incident.vehicle.id)
          return Promise.resolve(rule('invalid_association'));
        if ((order.kind ?? 'corrective') !== 'corrective')
          return Promise.resolve(rule('order_not_corrective'));
        if (order.status === 'cancelled') return Promise.resolve(rule('order_cancelled'));
        if (ctx.all().some((other) => other.repairs.some((l) => l.orderId === order.id)))
          return Promise.resolve(fail(409, 'duplicate'));
        sequence += 1;
        const link = { id: `link-${sequence}`, orderId: order.id, linkedAt: FAKE_NOW };
        record.repairs.push(link);
        ctx.entry(record, 'repair_linked', ['repairLinks']);
        const next = ctx.commit(record, clearApprovals(record));
        const result = { version: next.version, item: linkView(link) };
        keyed.set(`link:${key}`, { body: signature, result });
        return Promise.resolve(ok(result));
      },
      unlink: (id, linkId, version, key) => {
        const failed = ctx.injected('repairs.unlink');
        if (failed) return Promise.resolve(failed);
        const record = ctx.visible(id);
        if (!record) return Promise.resolve(fail(404, 'not_found'));
        const signature = JSON.stringify([id, linkId, version]);
        const earlier = keyed.get(`unlink:${key}`);
        if (earlier)
          return Promise.resolve(
            earlier.body === signature
              ? ok(earlier.result as never)
              : fail(409, 'idempotency_conflict'),
          );
        const gate = editGate(record);
        if (gate) return Promise.resolve(gate);
        if (record.incident.version !== version) return Promise.resolve(fail(409, 'stale_version'));
        const link = record.repairs.find((item) => item.id === linkId);
        if (!link) return Promise.resolve(fail(404, 'not_found'));
        const budget = record.evidence.some(
          (item) => item.category === 'budget' && item.fileStatus === 'clean',
        );
        if (record.incident.status === 'repair' && record.repairs.length === 1 && !budget)
          return Promise.resolve(
            fail(422, 'missing_requirements', { missingRequirements: ['repair_order_or_budget'] }),
          );
        record.repairs = record.repairs.filter((item) => item.id !== linkId);
        ctx.entry(record, 'repair_unlinked', ['repairLinks']);
        const result = { version: ctx.commit(record, clearApprovals(record)).version };
        keyed.set(`unlink:${key}`, { body: signature, result });
        return Promise.resolve(ok(result));
      },
    },
    costs: {
      get: (id) => {
        const failed = ctx.injected('costs.get');
        if (failed) return Promise.resolve(failed);
        // Without `incidents:view_costs` the server answers 403 and sends no amount.
        if (!has('incidents:view_costs')) return Promise.resolve(fail(403, 'forbidden'));
        const record = ctx.visible(id);
        return Promise.resolve(record ? ok(costsOf(record)) : fail(404, 'not_found'));
      },
      update: (id, body, key) => {
        const failed = ctx.injected('costs.update');
        if (failed) return Promise.resolve(failed);
        if (!has('incidents:view_costs')) return Promise.resolve(fail(403, 'forbidden'));
        const record = ctx.visible(id);
        if (!record) return Promise.resolve(fail(404, 'not_found'));
        const signature = JSON.stringify([id, body]);
        const earlier = keyed.get(`costs:${key}`);
        if (earlier)
          return Promise.resolve(
            earlier.body === signature
              ? ok(earlier.result as never)
              : fail(409, 'idempotency_conflict'),
          );
        if (!has('incidents:edit')) return Promise.resolve(fail(403, 'forbidden'));
        if (['draft', 'closed', 'cancelled'].includes(record.incident.status))
          return Promise.resolve(fail(409, 'invalid_transition'));
        if (record.incident.version !== body.version)
          return Promise.resolve(fail(409, 'stale_version'));
        const known = new Set(record.costs.lines.map((line) => line.id));
        const invalid =
          body.lines.length > 50 ||
          body.lines.some(
            (line) =>
              !AMOUNT.test(line.amount.amountMinor) ||
              (line.id !== undefined && !known.has(line.id)),
          ) ||
          (body.initialEstimate != null && !AMOUNT.test(body.initialEstimate.amountMinor));
        if (invalid) return Promise.resolve(fail(400, 'invalid_input'));
        record.costs.lines = body.lines.map((line): BffCostLine => {
          sequence += 1;
          return {
            id: line.id ?? `line-${sequence}`,
            kind: line.kind,
            category: line.category,
            amount: line.amount,
            note: line.note ?? null,
          };
        });
        if (body.initialEstimate !== undefined) record.costs.estimate = body.initialEstimate;
        ctx.entry(record, 'costs_changed', ['costs']);
        ctx.commit(record, clearApprovals(record));
        const result = costsOf(record);
        keyed.set(`costs:${key}`, { body: signature, result });
        return Promise.resolve(ok(result));
      },
    },
    alerts: {
      list: (query) => {
        const failed = ctx.injected('alerts.list');
        if (failed) return Promise.resolve(failed);
        if (!has('incidents:view')) return Promise.resolve(fail(403, 'forbidden'));
        const items = alerts
          .filter((alert) => !query?.kind || alert.kind === query.kind)
          .filter((alert) => !query?.incidentId || alert.incidentId === query.incidentId);
        const start = query?.offset ?? 0;
        return Promise.resolve(
          ok({ items: items.slice(start, start + (query?.limit ?? 25)), total: items.length }),
        );
      },
    },
    orders: {
      list: () => {
        const failed = ctx.injected('orders.list');
        if (failed) return Promise.resolve(failed);
        if (!has('view')) return Promise.resolve(fail(403, 'forbidden'));
        return Promise.resolve(ok([...orders.values()].map(toOrder)));
      },
      createCorrective: (body) => {
        const failed = ctx.injected('orders.createCorrective');
        if (failed) return Promise.resolve(failed);
        if (!has('create')) return Promise.resolve(fail(403, 'forbidden'));
        sequence += 1;
        const order: FakeOrder = {
          id: `order-new-${sequence}`,
          vehicleId: body.vehicleId,
          description: body.description,
          createdAt: FAKE_NOW,
        };
        orders.set(order.id, order);
        return Promise.resolve(ok(toOrder(order)));
      },
    },
    settings: {
      get: () => {
        const failed = ctx.injected('settings.get');
        if (failed) return Promise.resolve(failed);
        return Promise.resolve(ok(settings));
      },
      save: (body) => {
        const failed = ctx.injected('settings.save');
        if (failed) return Promise.resolve(failed);
        if (!has('manage_config')) return Promise.resolve(fail(403, 'forbidden'));
        if (body.version !== settings.version) return Promise.resolve(fail(409, 'stale_version'));
        const days = Object.values(body.incidentSlaDays ?? {});
        if (
          days.some((d) => !Number.isInteger(d) || d < 1 || d > 365) ||
          (body.incidentInactivityDays !== undefined &&
            (body.incidentInactivityDays < 1 || body.incidentInactivityDays > 60))
        )
          return Promise.resolve(fail(400, 'invalid_input'));
        const fields = omit(body, 'version');
        settings = {
          ...settings,
          ...fields,
          version: settings.version + 1,
          updatedAt: FAKE_NOW,
          updatedBy: ME.id,
        } as BffAlertSettings;
        return Promise.resolve(ok(settings));
      },
    },
  };
  return {
    ports,
    addAlert: (alert: BffIncidentAlert) => alerts.unshift(alert),
    /** The close command keeps a snapshot of the totals at that moment (one per cycle). */
    snapshot: (record: Record_) => {
      record.costs.snapshots.push({
        cycle: record.costs.snapshots.length + 1,
        closedAt: FAKE_NOW,
        totals: totalsOf(record),
        orders: record.repairs.map((link) => ({
          orderId: link.orderId,
          version: 1,
          status: orders.get(link.orderId)?.status ?? 'scheduled',
        })),
      });
    },
    /** Another person adds a line: the case's version moves on. */
    changeCostsExternally: (incidentId: string, lines: readonly BffCostLine[]) => {
      const record = ctx.visible(incidentId);
      if (!record) return;
      record.costs.lines = [...record.costs.lines, ...lines];
      record.incident = { ...record.incident, version: record.incident.version + 1 };
    },
  };
}
