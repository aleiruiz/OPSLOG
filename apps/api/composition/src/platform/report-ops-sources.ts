import type { AssignmentStore } from '../../../../../packages/domain/assignments/src/index.js';
import {
  AuditQueryError,
  type AuditChange,
  type AuditEntryView,
  type AuditQueryService,
} from '../../../../../packages/domain/audit-query/src/index.js';
import type { CostLedger } from '../../../../../packages/domain/incidents/costs/src/index.js';
import type {
  Incident,
  IncidentStore,
} from '../../../../../packages/domain/incidents/cases/src/index.js';
import type { IncidentRepairStore } from '../../../../../packages/domain/incidents/repairs/src/index.js';
import type { IncidentSlaReader } from '../../../../../packages/domain/incidents/sla/src/index.js';
import type { WorkshopStore } from '../../../../../packages/domain/maintenance/workshops/src/index.js';
import type { WorkOrderStore } from '../../../../../packages/domain/maintenance/orders/src/index.js';
import {
  targets,
  type PlanScheduleReader,
  type PlanStore,
} from '../../../../../packages/domain/maintenance/plans/src/index.js';
import {
  MAX_REPORT_ROWS,
  ReportError,
  type IncidentCostFact,
  type IncidentFact,
  type IncidentSlaFact,
  type OperationalSources,
  type ReportReader,
  type WorkOrderFact,
} from '../../../../../packages/domain/reports/src/index.js';
import type {
  VehicleAnalyticsReads,
  VehicleStore,
} from '../../../../../packages/domain/vehicles/src/index.js';

const PAGE = 100;

export interface OperationalInputs {
  readonly orders: WorkOrderStore;
  readonly plans: PlanStore;
  readonly workshops: Pick<WorkshopStore, 'list'>;
  readonly incidents: IncidentStore;
  readonly repairs: Pick<IncidentRepairStore, 'linkOfOrder'>;
  readonly ledger: Pick<CostLedger, 'read'>;
  readonly sla: Pick<IncidentSlaReader, 'forIncidents'>;
  readonly assignments: AssignmentStore;
  readonly vehicleStore: VehicleStore;
  readonly audit: Pick<AuditQueryService, 'list'>;
  /** Whether the member is a mechanic (D9): without `edit` / `incidents:edit` they see nothing here. */
  readonly mechanicLinked: (tenantId: string, memberId: string) => Promise<boolean>;
  readonly now: () => Date;
}

const scheduleReaderOf = (plans: PlanStore): PlanScheduleReader | undefined =>
  typeof (plans as Partial<PlanScheduleReader>).listScheduledOrders === 'function'
    ? (plans as unknown as PlanScheduleReader)
    : undefined;

const has = (reader: ReportReader, permission: string): boolean =>
  (reader.permissions as ReadonlySet<string>).has(permission);

const text = (value: unknown): string =>
  value === null || value === undefined ? '—' : String(value);

/** A changed field as the audit screen shows it: restricted and unrecorded values never print a value. */
function changeText(changes: readonly AuditChange[] | null): string | null {
  if (!changes || changes.length === 0) return null;
  return changes
    .map((c) =>
      c.state === 'value'
        ? `${c.label}: ${text(c.before)} → ${text(c.after)}`
        : `${c.label}: ${c.state === 'restricted' ? 'restringido' : 'sin registro'}`,
    )
    .join('; ');
}

/**
 * Reads of the maintenance, incident, audit and history reports over the owning modules' stores.
 * A mechanic-scoped member (linked, without the edit permission) gets nothing (SPECS D9), and money
 * is read only for the permission that protects it.
 */
export function operationalSources(inputs: OperationalInputs): OperationalSources {
  const schedule = scheduleReaderOf(inputs.plans);
  const scoped = async (reader: ReportReader, edit: 'edit' | 'incidents:edit'): Promise<boolean> =>
    reader.actorId === undefined ||
    (!has(reader, edit) && (await inputs.mechanicLinked(reader.tenantId, reader.actorId)));
  const caseOf = async (tenantId: string, ids: readonly string[]): Promise<readonly Incident[]> =>
    (await Promise.all(ids.map((id) => inputs.incidents.get(tenantId, id)))).filter(
      (incident): incident is Incident => incident !== null,
    );

  return {
    workOrders: async (reader, options) => {
      if (await scoped(reader, 'edit')) return [];
      const { tenantId } = reader;
      const [orders, workshops] = await Promise.all([
        inputs.orders.list(tenantId),
        inputs.workshops.list(tenantId),
      ]);
      const workshopName = new Map(workshops.map((w) => [w.id, w.name]));
      const withCosts = options.withCosts && has(reader, 'view_costs');
      const seeCases = has(reader, 'incidents:view');
      const kept = orders.filter(
        (o) => options.vehicleId === undefined || o.vehicleId === options.vehicleId,
      );
      if (kept.length > MAX_REPORT_ROWS) throw new ReportError('too_many_rows');
      // Targets of each occurrence: the plan's snapshot when the order was scheduled.
      const snapshots = new Map<string, { targetDate: string | null; targetKm: number | null }>();
      if (schedule)
        for (const planId of new Set(kept.flatMap((o) => (o.planId ? [o.planId] : []))))
          for (const scheduled of await schedule.listScheduledOrders(tenantId, planId))
            snapshots.set(scheduled.id, {
              targetDate: (scheduled.snapshot['targetDate'] as string | null | undefined) ?? null,
              targetKm: (scheduled.snapshot['targetKm'] as number | null | undefined) ?? null,
            });
      const facts: WorkOrderFact[] = [];
      for (const o of kept) {
        const link = seeCases ? await inputs.repairs.linkOfOrder(tenantId, o.id) : null;
        const linked = link ? await inputs.incidents.get(tenantId, link.incidentId) : null;
        const snapshot = snapshots.get(o.id);
        facts.push({
          id: o.id,
          kind: o.kind,
          vehicleId: o.vehicleId,
          planId: o.planId,
          status: o.status,
          description: o.description,
          workshop: o.workshopId ? (workshopName.get(o.workshopId) ?? null) : null,
          scheduledDate: o.scheduledDate,
          actualDate: o.actualDate,
          actualKm: o.actualKm,
          targetDate: snapshot?.targetDate ?? null,
          targetKm: snapshot?.targetKm ?? null,
          createdAt: o.createdAt,
          closedAt: o.closedAt,
          reopenCount: o.reopenCount,
          incidentFolio: linked?.folio ?? null,
          ...(withCosts
            ? {
                costs: o.costs.map((c) => ({
                  category: c.category,
                  amountMinor: c.amount.amountMinor,
                  currency: c.amount.currency,
                })),
              }
            : {}),
        });
      }
      return facts;
    },

    plans: async (reader) => {
      if (await scoped(reader, 'edit')) return [];
      return (await inputs.plans.list(reader.tenantId)).map((p) => ({
        id: p.id,
        vehicleId: p.vehicleId,
        state: p.state,
        intervalDays: p.intervalDays ?? null,
        intervalKm: p.intervalKm ?? null,
        nextTargetDate: targets(p).targetDate,
      }));
    },

    incidents: async (reader, options) => {
      if (await scoped(reader, 'incidents:edit')) return [];
      const facts: IncidentFact[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await inputs.incidents.list(reader.tenantId, {
          filter: options.vehicleId === undefined ? {} : { vehicleId: options.vehicleId },
          sort: 'createdAt',
          direction: 'asc',
          limit: 100,
          offset,
        });
        if (page.total > MAX_REPORT_ROWS) throw new ReportError('too_many_rows');
        for (const i of page.items)
          if (
            i.status !== 'draft' &&
            (options.driverId === undefined || i.driverId === options.driverId)
          )
            facts.push({
              id: i.id,
              folio: i.folio,
              type: i.type,
              severity: i.severity,
              status: i.status,
              cycle: i.cycle,
              reopenCount: i.reopenCount,
              vehicleId: i.vehicleId,
              driverId: i.driverId,
              areaId: i.areaId,
              occurredOn: i.occurredOn,
              reportedAt: i.reportedAt,
              resolvedAt: i.resolvedAt,
              closedAt: i.closedAt,
              totalLoss: i.totalLoss,
              coverageStatus: i.coverageStatus,
            });
        if (page.items.length === 0 || offset + PAGE >= page.total) return facts;
      }
    },

    incidentCosts: async (reader, ids) => {
      const result = new Map<string, readonly IncidentCostFact[]>();
      if (!has(reader, 'incidents:view_costs') || (await scoped(reader, 'incidents:edit')))
        return result;
      for (const id of ids) {
        const read = await inputs.ledger.read(reader.tenantId, id);
        result.set(
          id,
          read.totals.map((t) => {
            const byCategory: Record<string, bigint> = {};
            for (const line of read.lines)
              if (line.kind === 'expense' && line.amount.currency === t.currency)
                byCategory[line.category] =
                  (byCategory[line.category] ?? 0n) + BigInt(line.amount.amountMinor);
            return {
              currency: t.currency,
              repairs: t.repairs,
              expensesByCategory: Object.fromEntries(
                Object.entries(byCategory).map(([category, sum]) => [category, sum.toString()]),
              ),
              expenses: t.expenses,
              recoveries: t.recoveries,
              companyBorne: t.companyBorne,
            };
          }),
        );
      }
      return result;
    },

    incidentSteps: async (reader, ids) => {
      const result = new Map<string, readonly { command: string; to: string; at: string }[]>();
      if (await scoped(reader, 'incidents:edit')) return result;
      for (const id of ids)
        result.set(
          id,
          (await inputs.incidents.history(reader.tenantId, id)).map((t) => ({
            command: t.command,
            to: t.to,
            at: t.occurredAt,
          })),
        );
      return result;
    },

    incidentSla: async (reader, ids) => {
      const result = new Map<string, IncidentSlaFact>();
      if (await scoped(reader, 'incidents:edit')) return result;
      const views = await inputs.sla.forIncidents(
        reader.tenantId,
        await caseOf(reader.tenantId, ids),
      );
      for (const [id, v] of views)
        result.set(id, {
          state: v.state,
          cycle: v.cycle,
          startedAt: v.startedAt,
          deadline: v.deadline,
          targetDays: v.targetDays,
          resolvedAt: v.resolvedAt,
          previousCycles: v.previousCycles.map((c) => ({
            cycle: c.cycle,
            startedAt: c.startedAt,
            resolvedAt: c.resolvedAt,
            met: c.met,
          })),
        });
      return result;
    },

    assignmentHistory: async (tenantId, scope) => {
      const facts: {
        vehicleId: string;
        employeeId: string;
        type: string;
        startedAt: string;
        endedAt: string | null;
      }[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const page = await inputs.assignments.list(tenantId, scope, { limit: PAGE, offset });
        if (page.total > MAX_REPORT_ROWS) throw new ReportError('too_many_rows');
        for (const a of page.items)
          facts.push({
            vehicleId: a.vehicleId,
            employeeId: a.employeeId,
            type: a.type,
            startedAt: a.startedAt,
            endedAt: a.endedAt,
          });
        if (page.items.length === 0 || offset + PAGE >= page.total) return facts;
      }
    },

    statusHistory: async (tenantId, vehicleId) => {
      const store = inputs.vehicleStore as Partial<VehicleAnalyticsReads>;
      if (typeof store.analyticsStatusChanges !== 'function')
        throw new Error('The vehicles store does not provide the status history reads');
      const changes = await store.analyticsStatusChanges(
        tenantId,
        [vehicleId],
        inputs.now().toISOString(),
      );
      return changes.map((c) => ({ to: c.to, at: c.at }));
    },

    auditLog: async (reader, range) => {
      const permissions = [...reader.permissions];
      if (!permissions.includes('view_audit')) return [];
      const facts: ReturnType<typeof auditFact>[] = [];
      let after: { occurredAt: string; eventId: string } | undefined;
      try {
        for (;;) {
          const page = await inputs.audit.list(
            reader.tenantId,
            { permissions },
            {
              from: range.from,
              to: range.to,
              limit: 100,
              ...(range.entityType === undefined ? {} : { entityType: range.entityType }),
              ...(range.result === undefined ? {} : { result: range.result }),
              ...(range.action === undefined ? {} : { action: range.action }),
              ...(after ? { after } : {}),
            },
          );
          if (page.total > MAX_REPORT_ROWS) throw new ReportError('too_many_rows');
          facts.push(...page.items.map(auditFact));
          if (!page.next) return facts;
          after = page.next;
        }
      } catch (error) {
        if (error instanceof AuditQueryError) throw new ReportError('invalid_input', 'to');
        throw error;
      }
    },
  };
}

function auditFact(e: AuditEntryView) {
  return {
    occurredAt: e.occurredAt,
    actionLabel: e.actionLabel,
    result: e.result,
    entityType: e.entityType,
    entityTypeLabel: e.entityTypeLabel,
    entityLabel: e.entityLabel,
    actorLabel: e.actor.label,
    actorAlias: e.actor.alias,
    correlationId: e.correlationId,
    changes: changeText(e.changes),
  } as const;
}
