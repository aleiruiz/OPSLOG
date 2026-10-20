import type {
  AssignmentHistoryFact,
  AuditFact,
  AuditRange,
  IncidentCostFact,
  IncidentFact,
  IncidentSlaFact,
  IncidentStepFact,
  OperationalSources,
  PlanFact,
  ReportReader,
  StatusChangeFact,
  WorkOrderFact,
} from '../ports-ops.js';

export interface OpsData {
  workOrders: WorkOrderFact[];
  plans: PlanFact[];
  incidents: IncidentFact[];
  incidentCosts: Record<string, IncidentCostFact[]>;
  incidentSteps: Record<string, IncidentStepFact[]>;
  incidentSla: Record<string, IncidentSlaFact>;
  assignmentHistory: AssignmentHistoryFact[];
  statusHistory: Record<string, StatusChangeFact[]>;
  audit: (AuditFact & { entityType: string })[];
}

const order = (id: string, extra: Partial<WorkOrderFact>): WorkOrderFact => ({
  id,
  kind: 'preventive',
  vehicleId: 'v1',
  planId: null,
  status: 'closed',
  description: null,
  workshop: null,
  scheduledDate: null,
  actualDate: null,
  actualKm: null,
  targetDate: null,
  targetKm: null,
  createdAt: '2026-08-20T15:00:00.000Z',
  closedAt: null,
  reopenCount: 0,
  incidentFolio: null,
  ...extra,
});

const incident = (n: number, extra: Partial<IncidentFact>): IncidentFact => ({
  id: `i${n}`,
  folio: `SIN-2026-000${n}`,
  type: 'collision',
  severity: 'high',
  status: 'repair',
  cycle: 1,
  reopenCount: 0,
  vehicleId: 'v1',
  driverId: 'd1',
  areaId: 'a1',
  occurredOn: null,
  reportedAt: null,
  resolvedAt: null,
  closedAt: null,
  totalLoss: false,
  coverageStatus: 'covered',
  ...extra,
});

const step = (command: string, to: string, at: string): IncidentStepFact => ({ command, to, at });

const cost = (
  currency: string,
  repairs: string,
  byCategory: Record<string, string>,
  recoveries: string,
): IncidentCostFact => {
  const expenses = Object.values(byCategory).reduce((a, b) => a + BigInt(b), 0n);
  return {
    currency,
    repairs,
    expensesByCategory: byCategory,
    expenses: expenses.toString(),
    recoveries,
    companyBorne: (BigInt(repairs) + expenses - BigInt(recoveries)).toString(),
  };
};

const audit = (
  at: string,
  entityType: string,
  extra: Partial<AuditFact> = {},
): AuditFact & { entityType: string } => ({
  occurredAt: at,
  actionLabel: 'Vehículo actualizado',
  result: 'success',
  entityType,
  entityTypeLabel: 'Vehículo',
  entityLabel: 'ECO-1',
  actorLabel: 'Administración',
  actorAlias: 'Actor-1a2b',
  correlationId: 'corr-1',
  changes: null,
  ...extra,
});

/** Operational fixtures of company A: orders, plans, cases, their costs, steps and SLA, history and audit. */
export function opsA(): OpsData {
  return {
    plans: [
      {
        id: 'pl1',
        vehicleId: 'v1',
        state: 'active',
        intervalDays: 90,
        intervalKm: 10000,
        nextTargetDate: '2026-10-01',
      },
      {
        id: 'pl2',
        vehicleId: 'v2',
        state: 'active',
        intervalDays: 90,
        intervalKm: null,
        nextTargetDate: '2026-11-20',
      },
      {
        id: 'pl3',
        vehicleId: 'v3',
        state: 'paused',
        intervalDays: null,
        intervalKm: 5000,
        nextTargetDate: '2026-12-01',
      },
    ],
    workOrders: [
      order('w1', {
        planId: 'pl1',
        scheduledDate: '2026-09-01',
        targetDate: '2026-09-01',
        targetKm: 10000,
        actualDate: '2026-09-05',
        actualKm: 10400,
        closedAt: '2026-09-06T17:00:00.000Z',
        workshop: 'Taller Norte',
        costs: [
          { category: 'labor', amountMinor: '120000', currency: 'MXN' },
          { category: 'parts', amountMinor: '50050', currency: 'MXN' },
        ],
      }),
      order('w2', {
        planId: 'pl1',
        status: 'scheduled',
        scheduledDate: '2026-10-01',
        targetDate: '2026-10-01',
        targetKm: 20000,
      }),
      order('w3', {
        vehicleId: 'v2',
        planId: 'pl2',
        status: 'completed',
        scheduledDate: '2026-10-10',
        targetDate: '2026-10-10',
        targetKm: 5000,
        actualDate: '2026-10-08',
        actualKm: 4900,
        costs: [{ category: 'labor', amountMinor: '80000', currency: 'MXN' }],
      }),
      order('w4', {
        kind: 'corrective',
        description: 'Cambio de turbo',
        createdAt: '2026-09-10T15:00:00.000Z',
        actualDate: '2026-09-12',
        actualKm: 10600,
        closedAt: '2026-09-15T18:00:00.000Z',
        workshop: 'Taller Norte',
        reopenCount: 1,
        incidentFolio: 'SIN-2026-0001',
        costs: [
          { category: 'external_service', amountMinor: '300000', currency: 'MXN' },
          { category: 'parts', amountMinor: '100000', currency: 'USD' },
        ],
      }),
      order('w5', {
        kind: 'corrective',
        vehicleId: 'v2',
        status: 'cancelled',
        description: 'Ruido en frenos',
        createdAt: '2026-10-01T15:00:00.000Z',
      }),
      order('w6', {
        kind: 'corrective',
        status: 'in_progress',
        description: 'Fuga de aceite',
        createdAt: '2026-10-15T15:00:00.000Z',
      }),
      order('w7', {
        vehicleId: 'v2',
        planId: 'pl2',
        scheduledDate: '2026-07-10',
        targetDate: '2026-07-10',
        actualDate: '2026-07-10',
        actualKm: 3000,
        closedAt: '2026-07-11T17:00:00.000Z',
        costs: [{ category: 'labor', amountMinor: '50000', currency: 'MXN' }],
      }),
    ],
    incidents: [
      incident(1, {
        occurredOn: '2026-09-08',
        reportedAt: '2026-09-08T20:00:00.000Z',
      }),
      incident(2, {
        type: 'theft_total',
        severity: 'critical',
        status: 'closed',
        cycle: 2,
        reopenCount: 1,
        vehicleId: 'v2',
        driverId: 'd2',
        areaId: 'a2',
        occurredOn: '2026-08-15',
        reportedAt: '2026-08-15T14:00:00.000Z',
        resolvedAt: '2026-08-28T14:00:00.000Z',
        closedAt: '2026-08-30T14:00:00.000Z',
        totalLoss: true,
      }),
      incident(3, {
        type: 'parking_damage',
        severity: 'low',
        status: 'reported',
        driverId: null,
        occurredOn: '2026-10-10',
        reportedAt: '2026-10-10T16:00:00.000Z',
      }),
      incident(4, {
        status: 'cancelled',
        severity: 'medium',
        vehicleId: 'v2',
        areaId: 'a2',
        occurredOn: '2026-10-12',
        reportedAt: '2026-10-12T16:00:00.000Z',
      }),
      incident(5, {
        status: 'closed',
        vehicleId: 'v2',
        driverId: 'd2',
        areaId: 'a2',
        occurredOn: '2026-07-01',
        reportedAt: '2026-07-01T15:00:00.000Z',
        resolvedAt: '2026-07-06T15:00:00.000Z',
        closedAt: '2026-07-07T15:00:00.000Z',
      }),
    ],
    incidentCosts: {
      i1: [
        cost('MXN', '300000', { towing: '250000', deductible: '1500000' }, '400000'),
        cost('USD', '100000', {}, '0'),
      ],
      i2: [cost('MXN', '0', { legal: '50000', other: '10000' }, '0')],
      i5: [cost('MXN', '0', { repair: '500000' }, '100000')],
    },
    incidentSteps: {
      i2: [
        step('report', 'reported', '2026-08-15T14:00:00.000Z'),
        step('review', 'under_review', '2026-08-17T14:00:00.000Z'),
        step('insure', 'insurance_process', '2026-08-18T14:00:00.000Z'),
        step('resolve', 'resolved', '2026-08-25T14:00:00.000Z'),
        step('reopen', 'reopened', '2026-08-26T14:00:00.000Z'),
        step('resolve', 'resolved', '2026-08-28T14:00:00.000Z'),
      ],
      i5: [
        step('report', 'reported', '2026-07-01T15:00:00.000Z'),
        step('review', 'under_review', '2026-07-02T15:00:00.000Z'),
        step('repair', 'repair', '2026-07-03T15:00:00.000Z'),
        step('resolve', 'resolved', '2026-07-06T15:00:00.000Z'),
      ],
    },
    incidentSla: {
      i1: {
        state: 'breached',
        cycle: 1,
        startedAt: '2026-09-08T20:00:00.000Z',
        deadline: '2026-10-08T20:00:00.000Z',
        targetDays: 30,
        resolvedAt: null,
        previousCycles: [],
      },
      i2: {
        state: 'met',
        cycle: 2,
        startedAt: '2026-08-26T14:00:00.000Z',
        deadline: '2026-09-02T14:00:00.000Z',
        targetDays: 7,
        resolvedAt: '2026-08-28T14:00:00.000Z',
        previousCycles: [
          {
            cycle: 1,
            startedAt: '2026-08-15T14:00:00.000Z',
            resolvedAt: '2026-08-25T14:00:00.000Z',
            met: false,
          },
        ],
      },
      i3: {
        state: 'on_track',
        cycle: 1,
        startedAt: '2026-10-10T16:00:00.000Z',
        deadline: '2026-10-30T16:00:00.000Z',
        targetDays: 20,
        resolvedAt: null,
        previousCycles: [],
      },
      i5: {
        state: 'met',
        cycle: 1,
        startedAt: '2026-07-01T15:00:00.000Z',
        deadline: '2026-07-31T15:00:00.000Z',
        targetDays: 30,
        resolvedAt: '2026-07-06T15:00:00.000Z',
        previousCycles: [],
      },
    },
    assignmentHistory: [
      {
        vehicleId: 'v1',
        employeeId: 'd1',
        type: 'principal',
        startedAt: '2025-01-10T15:00:00.000Z',
        endedAt: null,
      },
      {
        vehicleId: 'v1',
        employeeId: 'd2',
        type: 'secondary',
        startedAt: '2024-06-01T15:00:00.000Z',
        endedAt: '2024-12-31T15:00:00.000Z',
      },
    ],
    statusHistory: {
      v1: [
        { to: 'active', at: '2024-01-15T18:00:00.000Z' },
        { to: 'in_maintenance', at: '2026-10-10T03:00:00.000Z' },
      ],
    },
    audit: [
      audit('2026-10-18T20:30:00.000Z', 'vehicle', {
        changes: 'Estado: Activo → En mantenimiento',
      }),
      audit('2026-10-17T15:00:00.000Z', 'incident', {
        actionLabel: 'Acceso a siniestro denegado',
        result: 'denied',
        entityTypeLabel: 'Siniestro',
        entityLabel: 'Siniestro SIN-2026-0001',
      }),
      audit('2026-08-01T15:00:00.000Z', 'area', { entityTypeLabel: 'Área', entityLabel: 'Norte' }),
    ],
  };
}

export function opsEmpty(): OpsData {
  return {
    plans: [],
    workOrders: [],
    incidents: [],
    incidentCosts: {},
    incidentSteps: {},
    incidentSla: {},
    assignmentHistory: [],
    statusHistory: {},
    audit: [],
  };
}

/** In-memory operational sources with the same gates as the composition: costs by permission, mechanics get nothing. */
export class MemoryOps implements OperationalSources {
  public readonly costReads: { permitted: boolean }[] = [];
  public readonly auditReads: AuditRange[] = [];
  /** Actors whose scope is a mechanic's (D9): they read no order and no case. */
  public readonly scopedActors = new Set<string>();

  public constructor(public readonly opsTenants: Record<string, OpsData>) {}

  private ops(reader: { readonly tenantId: string }): OpsData {
    const found = this.opsTenants[reader.tenantId];
    if (!found) throw new Error('unknown tenant');
    return found;
  }
  private scoped(reader: ReportReader): boolean {
    return reader.actorId === undefined || this.scopedActors.has(reader.actorId);
  }

  public async workOrders(
    reader: ReportReader,
    options: { readonly vehicleId?: string; readonly withCosts: boolean },
  ) {
    if (this.scoped(reader)) return [];
    const permitted = options.withCosts && reader.permissions.has('view_costs');
    this.costReads.push({ permitted });
    return this.ops(reader)
      .workOrders.filter(
        (o) => options.vehicleId === undefined || o.vehicleId === options.vehicleId,
      )
      .map((o) => {
        const { costs, ...rest } = o;
        return permitted && costs ? { ...rest, costs } : rest;
      });
  }
  public async plans(reader: ReportReader) {
    return this.scoped(reader) ? [] : this.ops(reader).plans;
  }
  public async incidents(
    reader: ReportReader,
    options: { readonly vehicleId?: string; readonly driverId?: string },
  ) {
    if (this.scoped(reader) || !reader.permissions.has('incidents:view')) return [];
    return this.ops(reader).incidents.filter(
      (i) =>
        (options.vehicleId === undefined || i.vehicleId === options.vehicleId) &&
        (options.driverId === undefined || i.driverId === options.driverId),
    );
  }
  public async incidentCosts(reader: ReportReader, ids: readonly string[]) {
    const permitted = reader.permissions.has('incidents:view_costs') && !this.scoped(reader);
    this.costReads.push({ permitted });
    const costs = this.ops(reader).incidentCosts;
    return new Map(
      permitted
        ? ids.filter((id) => costs[id]).map((id) => [id, costs[id] as IncidentCostFact[]])
        : [],
    );
  }
  public async incidentSteps(reader: ReportReader, ids: readonly string[]) {
    const steps = this.ops(reader).incidentSteps;
    return new Map(
      ids.filter((id) => steps[id]).map((id) => [id, steps[id] as IncidentStepFact[]]),
    );
  }
  public async incidentSla(reader: ReportReader, ids: readonly string[]) {
    const slas = this.ops(reader).incidentSla;
    return new Map(ids.filter((id) => slas[id]).map((id) => [id, slas[id] as IncidentSlaFact]));
  }
  public async assignmentHistory(
    tenantId: string,
    scope: { readonly vehicleId?: string; readonly employeeId?: string },
  ) {
    return this.ops({ tenantId }).assignmentHistory.filter(
      (a) =>
        (scope.vehicleId === undefined || a.vehicleId === scope.vehicleId) &&
        (scope.employeeId === undefined || a.employeeId === scope.employeeId),
    );
  }
  public async statusHistory(tenantId: string, vehicleId: string) {
    return this.ops({ tenantId }).statusHistory[vehicleId] ?? [];
  }
  public async auditLog(reader: ReportReader, range: AuditRange) {
    this.auditReads.push(range);
    return this.ops(reader)
      .audit.filter(
        (a) =>
          a.occurredAt >= range.from &&
          a.occurredAt < range.to &&
          (range.entityType === undefined || a.entityType === range.entityType) &&
          (range.result === undefined || a.result === range.result),
      )
      .sort((x, y) => y.occurredAt.localeCompare(x.occurredAt));
  }
}
