import { INCIDENT_STATUS_LABELS, INCIDENT_TYPE_LABELS, OPEN_INCIDENT_STATUSES } from '../labels.js';
import { moneyText, type Amount } from '../money.js';
import type { IncidentCostFact, IncidentFact } from '../ports-ops.js';
import { APPLIED, groupBy, round } from '../rows.js';
import type { ReportContext, ReportDefinition, Row } from '../types.js';
import type { ReportSources } from '../ports.js';
import { incidentFilters, keepIncident, loadIncidents } from './incident-support.js';

const DAY_MS = 86_400_000;

const isOpen = (incident: IncidentFact): boolean =>
  OPEN_INCIDENT_STATUSES.includes(incident.status);

/** The cost the company bore, per currency, as text: currencies are listed apart, never added together. */
async function borneText(
  ctx: ReportContext,
  sources: ReportSources,
  incidents: readonly IncidentFact[],
  wanted: boolean,
): Promise<(group: readonly IncidentFact[]) => string | null> {
  if (!wanted || incidents.length === 0) return () => null;
  const costs = await sources.incidentCosts(
    ctx,
    incidents.map((i) => i.id),
  );
  return (group) =>
    moneyText(
      group.flatMap((incident): Amount[] =>
        (costs.get(incident.id) ?? []).map((c: IncidentCostFact) => ({
          currency: c.currency,
          amountMinor: c.companyBorne,
        })),
      ),
    );
}

const severityCounts = (group: readonly IncidentFact[]): Row => ({
  low: group.filter((i) => i.severity === 'low').length,
  medium: group.filter((i) => i.severity === 'medium').length,
  high: group.filter((i) => i.severity === 'high').length,
  critical: group.filter((i) => i.severity === 'critical').length,
  unrated: group.filter((i) => i.severity === null).length,
});

const SEVERITY_COLUMNS = [
  { id: 'low', label: 'Baja', kind: 'integer' },
  { id: 'medium', label: 'Media', kind: 'integer' },
  { id: 'high', label: 'Alta', kind: 'integer' },
  { id: 'critical', label: 'Crítica', kind: 'integer' },
  { id: 'unrated', label: 'Sin severidad', kind: 'integer' },
] as const;

/** BRD §13.1 «Siniestros por período»: cases by month with their severity, state and cost. */
export const INCIDENTS_BY_PERIOD: ReportDefinition = {
  id: 'incidents_by_period',
  family: 'incidents',
  title: 'Siniestros por período',
  description:
    'Siniestros por mes de ocurrencia con severidad, estado y costo a cargo de la empresa.',
  view: 'incidents:view',
  columns: [
    { id: 'period', label: 'Período', kind: 'text' },
    { id: 'total', label: 'Siniestros', kind: 'integer' },
    ...SEVERITY_COLUMNS,
    { id: 'open', label: 'Abiertos', kind: 'integer' },
    { id: 'closed', label: 'Cerrados', kind: 'integer' },
    { id: 'cancelled', label: 'Cancelados', kind: 'integer' },
    { id: 'totalLoss', label: 'Pérdida total', kind: 'integer' },
    {
      id: 'cost',
      label: 'Costo a cargo de la empresa',
      kind: 'text',
      sensitivity: 'incident_costs',
    },
  ],
  filters: incidentFilters(true),
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'period', direction: 'desc' },
  async load(ctx, needed, sources, filters) {
    const { incidents } = await loadIncidents(ctx, sources);
    const kept = incidents.filter((i) => keepIncident(i, filters));
    const cost = await borneText(ctx, sources, kept, needed.has('cost'));
    return [...groupBy(kept, (i) => i.occurredOn?.slice(0, 7) ?? 'Sin fecha')].map(
      ([period, group]): Row => ({
        period,
        total: group.length,
        ...severityCounts(group),
        open: group.filter(isOpen).length,
        closed: group.filter((i) => i.status === 'closed').length,
        cancelled: group.filter((i) => i.status === 'cancelled').length,
        totalLoss: group.filter((i) => i.totalLoss === true).length,
        cost: cost(group),
      }),
    );
  },
};

/** BRD §13.1 «Siniestros por vehículo / conductor»: one row per vehicle or driver with cases. */
export const INCIDENTS_BY_SUBJECT: ReportDefinition = {
  id: 'incidents_by_subject',
  family: 'incidents',
  title: 'Siniestros por vehículo y conductor',
  description:
    'Siniestros agrupados por vehículo o por conductor, con severidad, duración y costo.',
  view: 'incidents:view',
  columns: [
    { id: 'subjectKind', label: 'Agrupado por', kind: 'text' },
    { id: 'subject', label: 'Vehículo o conductor', kind: 'text' },
    { id: 'total', label: 'Siniestros', kind: 'integer' },
    { id: 'open', label: 'Abiertos', kind: 'integer' },
    { id: 'severe', label: 'Alta o crítica', kind: 'integer' },
    { id: 'totalLoss', label: 'Pérdida total', kind: 'integer' },
    { id: 'lastOn', label: 'Último siniestro', kind: 'date' },
    { id: 'avgResolutionDays', label: 'Días medios a la resolución', kind: 'number' },
    {
      id: 'cost',
      label: 'Costo a cargo de la empresa',
      kind: 'text',
      sensitivity: 'incident_costs',
    },
  ],
  filters: [
    {
      id: 'subject',
      label: 'Agrupar por',
      kind: 'enum',
      options: [
        { value: 'vehicle', label: 'Vehículo' },
        { value: 'driver', label: 'Conductor' },
      ],
      test: APPLIED,
    },
    ...incidentFilters(true),
  ],
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'total', direction: 'desc' },
  async load(ctx, needed, sources, filters) {
    const lookup = await loadIncidents(ctx, sources);
    const kept = lookup.incidents.filter((i) => keepIncident(i, filters));
    const cost = await borneText(ctx, sources, kept, needed.has('cost'));
    const only = filters.get('subject');
    const summarize = (kind: string, subject: string, group: readonly IncidentFact[]): Row => {
      const days = group
        .filter((i) => i.reportedAt !== null && i.resolvedAt !== null)
        .map(
          (i) => (Date.parse(i.resolvedAt as string) - Date.parse(i.reportedAt as string)) / DAY_MS,
        );
      return {
        subjectKind: kind,
        subject,
        total: group.length,
        open: group.filter(isOpen).length,
        severe: group.filter((i) => i.severity === 'high' || i.severity === 'critical').length,
        totalLoss: group.filter((i) => i.totalLoss === true).length,
        lastOn:
          group
            .map((i) => i.occurredOn)
            .filter((d): d is string => d !== null)
            .sort()
            .at(-1) ?? null,
        avgResolutionDays:
          days.length === 0 ? null : round(days.reduce((a, b) => a + b, 0) / days.length, 1),
        cost: cost(group),
      };
    };
    const rows: Row[] = [];
    if (only !== 'driver')
      for (const [id, group] of groupBy(kept, (i) => i.vehicleId))
        rows.push(summarize('Vehículo', lookup.vehicle(id) ?? 'Vehículo no disponible', group));
    if (only !== 'vehicle')
      for (const [id, group] of groupBy(kept, (i) => i.driverId ?? ''))
        rows.push(
          summarize('Conductor', lookup.driver(id === '' ? null : id) ?? 'Sin conductor', group),
        );
    return rows;
  },
};

/** BRD §13.1 «Siniestros por tipo / severidad / estado»: a cross table of cases. */
export const INCIDENTS_DISTRIBUTION: ReportDefinition = {
  id: 'incidents_distribution',
  family: 'incidents',
  title: 'Siniestros por tipo, severidad y estado',
  description: 'Tabla cruzada de siniestros: filas por tipo o por estado, columnas por severidad.',
  view: 'incidents:view',
  columns: [
    { id: 'category', label: 'Categoría', kind: 'text' },
    ...SEVERITY_COLUMNS,
    { id: 'total', label: 'Total', kind: 'integer' },
  ],
  filters: [
    {
      id: 'rows',
      label: 'Filas por',
      kind: 'enum',
      options: [
        { value: 'type', label: 'Tipo' },
        { value: 'status', label: 'Estado' },
      ],
      test: APPLIED,
    },
    ...incidentFilters(true),
  ],
  formats: ['csv', 'xlsx'],
  defaultSort: { column: 'total', direction: 'desc' },
  async load(ctx, _needed, sources, filters) {
    const { incidents } = await loadIncidents(ctx, sources);
    const kept = incidents.filter((i) => keepIncident(i, filters));
    const byStatus = filters.get('rows') === 'status';
    const labels = byStatus ? INCIDENT_STATUS_LABELS : INCIDENT_TYPE_LABELS;
    return Object.entries(labels).map(([code, text]): Row => {
      const group = kept.filter((i) => (byStatus ? i.status : i.type) === code);
      return { category: text, ...severityCounts(group), total: group.length };
    });
  },
};
