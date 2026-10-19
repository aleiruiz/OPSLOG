import { dayInZone, daysBetween } from '../calendar.js';
import {
  INCIDENT_STATUS_LABELS,
  INCIDENT_TYPE_LABELS,
  OPEN_INCIDENT_STATUSES,
  SEVERITY_LABELS,
  SLA_STATE_LABELS,
  label,
  optionsOf,
} from '../labels.js';
import { decimalNumber } from '../money.js';
import type { IncidentSlaFact, IncidentStepFact } from '../ports-ops.js';
import { containsText, groupBy, percentiles, round } from '../rows.js';
import type { ReportColumn, ReportDefinition, Row } from '../types.js';
import { incidentFilters, keepIncident, loadIncidents } from './incident-support.js';

const DAY_MS = 86_400_000;
const money = (id: string, text: string): ReportColumn => ({
  id,
  label: text,
  kind: 'number',
  sensitivity: 'incident_costs',
});

/**
 * BRD §13.1 «Costos de siniestros»: one row per case and currency, exactly the totals of the case
 * (the orders it repairs through are counted once). There is no column for the driver as payer (D15).
 */
export const INCIDENT_COSTS: ReportDefinition = {
  id: 'incident_costs',
  family: 'incidents',
  title: 'Costos de siniestros',
  description:
    'Costos por siniestro y moneda: reparaciones, gastos por categoría, recuperaciones y neto a cargo de la empresa.',
  view: 'incidents:view_costs',
  columns: [
    { id: 'folio', label: 'Folio', kind: 'text' },
    { id: 'occurredOn', label: 'Fecha del evento', kind: 'date' },
    { id: 'type', label: 'Tipo', kind: 'text' },
    { id: 'severity', label: 'Severidad', kind: 'text' },
    { id: 'status', label: 'Estado', kind: 'text' },
    { id: 'vehicle', label: 'Vehículo', kind: 'text' },
    { id: 'currency', label: 'Moneda', kind: 'text', sensitivity: 'incident_costs' },
    money('repairs', 'Reparaciones (órdenes vinculadas)'),
    money('ownRepairs', 'Reparación sin orden'),
    money('deductible', 'Deducible'),
    money('towing', 'Grúa'),
    money('fines', 'Multas'),
    money('thirdPartyDamage', 'Daño a terceros'),
    money('legal', 'Legal'),
    money('otherExpenses', 'Otros gastos'),
    money('expenses', 'Gastos propios'),
    money('recoveries', 'Recuperaciones'),
    money('companyBorne', 'A cargo de la empresa'),
  ],
  filters: incidentFilters(false),
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'occurredOn', direction: 'desc' },
  async load(ctx, _needed, sources) {
    const lookup = await loadIncidents(ctx, sources);
    const costs = await sources.incidentCosts(
      ctx,
      lookup.incidents.map((i) => i.id),
    );
    return lookup.incidents.flatMap((incident) =>
      (costs.get(incident.id) ?? []).map((c): Row => {
        const value = (minor: string | undefined): number =>
          decimalNumber(minor ?? '0', c.currency);
        const by = (category: string) => value(c.expensesByCategory[category]);
        return {
          folio: incident.folio,
          occurredOn: incident.occurredOn,
          type: label(INCIDENT_TYPE_LABELS, incident.type),
          severity: incident.severity ? label(SEVERITY_LABELS, incident.severity) : null,
          status: label(INCIDENT_STATUS_LABELS, incident.status),
          vehicle: lookup.vehicle(incident.vehicleId),
          currency: c.currency,
          repairs: value(c.repairs),
          ownRepairs: by('repair'),
          deductible: by('deductible'),
          towing: by('towing'),
          fines: by('fine'),
          thirdPartyDamage: by('third_party_damage'),
          legal: by('legal'),
          otherExpenses: by('other'),
          expenses: value(c.expenses),
          recoveries: value(c.recoveries),
          companyBorne: value(c.companyBorne),
          _areaId: incident.areaId,
          _type: incident.type,
          _severity: incident.severity,
          _status: incident.status,
          _occurredOn: incident.occurredOn,
        };
      }),
    );
  },
};

/** Stage of the process each status of a case counts in. */
const STAGE_OF: Readonly<Record<string, string>> = {
  reported: 'daysReported',
  reopened: 'daysReported',
  under_review: 'daysReview',
  insurance_process: 'daysInsurer',
  insurance_rejected: 'daysInsurer',
  no_insurance: 'daysDirect',
  repair: 'daysRepair',
};
const STAGES = ['daysReported', 'daysReview', 'daysInsurer', 'daysDirect', 'daysRepair'] as const;

interface Cycle {
  readonly days: number;
  readonly stages: Readonly<Record<string, number>>;
  readonly met: boolean | null;
  readonly reopened: boolean;
}

/** The resolved cycles of a case: the report (or the reopen) to the resolution, with the days in each stage. */
function cyclesOf(
  reportedAt: string | null,
  steps: readonly IncidentStepFact[],
  sla: IncidentSlaFact | undefined,
): Cycle[] {
  const starts = [
    ...(reportedAt === null ? [] : [reportedAt]),
    ...steps.filter((s) => s.command === 'reopen').map((s) => s.at),
  ];
  const resolutions = steps.filter((s) => s.command === 'resolve').map((s) => s.at);
  const cycles: Cycle[] = [];
  resolutions.forEach((end, index) => {
    const start = starts[index];
    if (start === undefined) return;
    const window = steps.filter((s) => s.at >= start && s.at <= end);
    const stages: Record<string, number> = {};
    window.slice(0, -1).forEach((step, i) => {
      const stage = STAGE_OF[step.to];
      if (stage)
        stages[stage] =
          (stages[stage] ?? 0) +
          (Date.parse((window[i + 1] as IncidentStepFact).at) - Date.parse(step.at)) / DAY_MS;
    });
    const number = index + 1;
    const previous = sla?.previousCycles.find((c) => c.cycle === number);
    const met =
      sla === undefined
        ? null
        : number < sla.cycle
          ? (previous?.met ?? null)
          : number === sla.cycle && sla.deadline !== null && sla.resolvedAt !== null
            ? Date.parse(sla.resolvedAt) <= Date.parse(sla.deadline)
            : null;
    cycles.push({
      days: (Date.parse(end) - Date.parse(start)) / DAY_MS,
      stages,
      met,
      reopened: index > 0,
    });
  });
  return cycles;
}

/**
 * BRD §13.1 «Tiempo de resolución»: days to resolve and the share that met the SLA, by severity.
 * A reopened cycle is measured apart and never merged into the first one (SPECS §6.2).
 */
export const INCIDENT_RESOLUTION: ReportDefinition = {
  id: 'incident_resolution',
  family: 'incidents',
  title: 'Tiempo de resolución de siniestros',
  description:
    'Días a la resolución (mediana y p90), días por etapa y cumplimiento del plazo, por severidad y ciclo.',
  view: 'incidents:view',
  columns: [
    { id: 'severity', label: 'Severidad', kind: 'text' },
    { id: 'cycleKind', label: 'Ciclo', kind: 'text' },
    { id: 'cycles', label: 'Ciclos resueltos', kind: 'integer' },
    { id: 'medianDays', label: 'Mediana (días)', kind: 'number' },
    { id: 'p90Days', label: 'p90 (días)', kind: 'number' },
    { id: 'slaMetPct', label: 'Plazo cumplido (%)', kind: 'number' },
    { id: 'daysReported', label: 'Días medios reportado', kind: 'number' },
    { id: 'daysReview', label: 'Días medios en revisión', kind: 'number' },
    { id: 'daysInsurer', label: 'Días medios con aseguradora', kind: 'number' },
    { id: 'daysDirect', label: 'Días medios sin aseguradora', kind: 'number' },
    { id: 'daysRepair', label: 'Días medios en reparación', kind: 'number' },
  ],
  filters: incidentFilters(true),
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'cycles', direction: 'desc' },
  async load(ctx, _needed, sources, filters) {
    const { incidents } = await loadIncidents(ctx, sources);
    const kept = incidents.filter((i) => keepIncident(i, filters));
    const ids = kept.map((i) => i.id);
    const [steps, slas] = await Promise.all([
      sources.incidentSteps(ctx, ids),
      sources.incidentSla(ctx, ids),
    ]);
    const cycles = kept.flatMap((incident) =>
      cyclesOf(incident.reportedAt, steps.get(incident.id) ?? [], slas.get(incident.id)).map(
        (cycle) => ({ ...cycle, severity: incident.severity }),
      ),
    );
    const mean = (xs: readonly number[]): number | null =>
      xs.length === 0 ? null : round(xs.reduce((a, b) => a + b, 0) / xs.length, 1);
    return [...groupBy(cycles, (c) => `${c.severity ?? ''}|${c.reopened ? 'r' : 'f'}`)].map(
      ([, group]): Row => {
        const first = group[0] as (typeof cycles)[number];
        const stats = percentiles(group.map((c) => c.days));
        const judged = group.filter((c) => c.met !== null);
        return {
          severity: first.severity ? label(SEVERITY_LABELS, first.severity) : 'Sin severidad',
          cycleKind: first.reopened ? 'Reaperturas' : 'Primer ciclo',
          cycles: group.length,
          medianDays: stats ? round(stats.median, 1) : null,
          p90Days: stats ? round(stats.p90, 1) : null,
          slaMetPct:
            judged.length === 0
              ? null
              : round((judged.filter((c) => c.met === true).length / judged.length) * 100, 1),
          ...Object.fromEntries(
            STAGES.map((stage) => [stage, mean(group.map((c) => c.stages[stage] ?? 0))]),
          ),
        };
      },
    );
  },
};

const BUCKETS = [
  { value: 'd7', label: '0 a 7 días', max: 7 },
  { value: 'd15', label: '8 a 15 días', max: 15 },
  { value: 'd30', label: '16 a 30 días', max: 30 },
  { value: 'd60', label: '31 a 60 días', max: 60 },
  { value: 'd61', label: 'Más de 60 días', max: Infinity },
] as const;

/** BRD §13.1 «Abiertos / envejecimiento»: the cases still open, how old they are and where their SLA stands. */
export const INCIDENT_AGING: ReportDefinition = {
  id: 'incident_aging',
  family: 'incidents',
  title: 'Siniestros abiertos y envejecimiento',
  description: 'Siniestros abiertos con su antigüedad, rango de envejecimiento y estado del plazo.',
  view: 'incidents:view',
  columns: [
    { id: 'folio', label: 'Folio', kind: 'text' },
    { id: 'type', label: 'Tipo', kind: 'text' },
    { id: 'severity', label: 'Severidad', kind: 'text' },
    { id: 'status', label: 'Estado', kind: 'text' },
    { id: 'vehicle', label: 'Vehículo', kind: 'text' },
    { id: 'driver', label: 'Conductor', kind: 'text' },
    { id: 'area', label: 'Área', kind: 'text' },
    { id: 'reportedOn', label: 'Reportado', kind: 'date' },
    { id: 'ageDays', label: 'Antigüedad (días)', kind: 'integer' },
    { id: 'bucket', label: 'Rango', kind: 'text' },
    { id: 'slaState', label: 'Plazo', kind: 'text' },
    { id: 'deadline', label: 'Fecha límite', kind: 'date' },
    { id: 'daysToDeadline', label: 'Días al límite', kind: 'integer' },
  ],
  filters: [
    ...incidentFilters(false).filter((f) => f.id !== 'status'),
    {
      id: 'status',
      label: 'Estado',
      kind: 'enum',
      options: optionsOf(
        Object.fromEntries(
          OPEN_INCIDENT_STATUSES.map((s) => [s, label(INCIDENT_STATUS_LABELS, s)]),
        ),
      ),
      test: (row, value) => row['_status'] === value,
    },
    {
      id: 'bucket',
      label: 'Rango de antigüedad',
      kind: 'enum',
      options: BUCKETS.map(({ value, label: text }) => ({ value, label: text })),
      test: (row, value) => row['_bucket'] === value,
    },
    {
      id: 'sla',
      label: 'Estado del plazo',
      kind: 'enum',
      options: optionsOf(SLA_STATE_LABELS),
      test: (row, value) => row['_sla'] === value,
    },
    {
      id: 'folio',
      label: 'Folio (contiene)',
      kind: 'text',
      test: (row, value) => containsText(row['folio'], value),
    },
  ],
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'ageDays', direction: 'desc' },
  async load(ctx, _needed, sources) {
    const lookup = await loadIncidents(ctx, sources);
    const open = lookup.incidents.filter((i) => OPEN_INCIDENT_STATUSES.includes(i.status));
    const slas = await sources.incidentSla(
      ctx,
      open.map((i) => i.id),
    );
    return open.map((incident): Row => {
      const reportedOn =
        incident.reportedAt === null
          ? incident.occurredOn
          : dayInZone(new Date(incident.reportedAt), ctx.timeZone);
      const age = reportedOn === null ? null : Math.max(0, daysBetween(reportedOn, ctx.today));
      const sla = slas.get(incident.id);
      const deadline = sla?.deadline ? dayInZone(new Date(sla.deadline), ctx.timeZone) : null;
      const bucket = age === null ? null : BUCKETS.find((b) => age <= b.max);
      return {
        folio: incident.folio,
        type: label(INCIDENT_TYPE_LABELS, incident.type),
        severity: incident.severity ? label(SEVERITY_LABELS, incident.severity) : null,
        status: label(INCIDENT_STATUS_LABELS, incident.status),
        vehicle: lookup.vehicle(incident.vehicleId),
        driver: lookup.driver(incident.driverId),
        area: lookup.area(incident.areaId),
        reportedOn,
        ageDays: age,
        bucket: bucket?.label ?? null,
        slaState: sla ? label(SLA_STATE_LABELS, sla.state) : null,
        deadline,
        daysToDeadline: deadline === null ? null : daysBetween(ctx.today, deadline),
        _areaId: incident.areaId,
        _type: incident.type,
        _severity: incident.severity,
        _status: incident.status,
        _occurredOn: incident.occurredOn,
        _bucket: bucket?.value ?? null,
        _sla: sla?.state ?? null,
      };
    });
  },
};
