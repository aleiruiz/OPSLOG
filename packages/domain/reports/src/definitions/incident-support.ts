import {
  INCIDENT_STATUS_LABELS,
  INCIDENT_TYPE_LABELS,
  SEVERITY_LABELS,
  optionsOf,
} from '../labels.js';
import type { IncidentFact } from '../ports-ops.js';
import { APPLIED, fullName, indexBy, inPeriod, textFilter, vehicleLabel } from '../rows.js';
import type { ReportContext, ReportFilter } from '../types.js';
import type { ReportSources } from '../ports.js';
import type { Row } from '../types.js';
import { AREA, FROM, TO } from './period.js';

/** Filters every incident report offers; an aggregating report applies them to its facts, the rest to its rows. */
export function incidentFilters(applied: boolean): readonly ReportFilter[] {
  const same = (field: string) =>
    applied ? APPLIED : (row: Row, value: string | number) => row[field] === value;
  return [
    applied ? { ...AREA, test: APPLIED } : AREA,
    {
      id: 'type',
      label: 'Tipo',
      kind: 'enum',
      options: optionsOf(INCIDENT_TYPE_LABELS),
      test: same('_type'),
    },
    {
      id: 'severity',
      label: 'Severidad',
      kind: 'enum',
      options: optionsOf(SEVERITY_LABELS),
      test: same('_severity'),
    },
    {
      id: 'status',
      label: 'Estado',
      kind: 'enum',
      options: optionsOf(INCIDENT_STATUS_LABELS),
      test: same('_status'),
    },
    applied
      ? FROM
      : {
          ...FROM,
          label: 'Ocurrido desde',
          test: (row, value) =>
            typeof row['_occurredOn'] === 'string' && row['_occurredOn'] >= String(value),
        },
    applied
      ? TO
      : {
          ...TO,
          label: 'Ocurrido hasta',
          test: (row, value) =>
            typeof row['_occurredOn'] === 'string' && row['_occurredOn'] <= String(value),
        },
  ] as readonly ReportFilter[];
}

/** True when a case passes the filters the loader of an aggregating report applies to its facts. */
export function keepIncident(
  incident: IncidentFact,
  filters: ReadonlyMap<string, string | number>,
): boolean {
  const same = (id: string, value: string | null): boolean => {
    const wanted = textFilter(filters, id);
    return wanted === undefined || wanted === value;
  };
  return (
    same('areaId', incident.areaId) &&
    same('type', incident.type) &&
    same('severity', incident.severity) &&
    same('status', incident.status) &&
    inPeriod(incident.occurredOn, filters)
  );
}

export interface IncidentLookup {
  readonly incidents: readonly IncidentFact[];
  readonly vehicle: (id: string) => string | null;
  readonly driver: (id: string | null) => string | null;
  readonly area: (id: string) => string | null;
}

/** The cases of the reader with the names the reports print for their vehicle, driver and area. */
export async function loadIncidents(
  ctx: ReportContext,
  sources: ReportSources,
  scope: { readonly vehicleId?: string; readonly driverId?: string } = {},
): Promise<IncidentLookup> {
  const [incidents, vehicles, drivers, areas] = await Promise.all([
    sources.incidents(ctx, scope),
    sources.vehicles(ctx.tenantId),
    sources.people(ctx.tenantId, 'driver'),
    sources.areas(ctx.tenantId),
  ]);
  const vehicleById = indexBy(vehicles, (v) => v.id);
  const driverById = indexBy(drivers, (d) => d.id);
  const areaById = indexBy(areas, (a) => a.id);
  return {
    incidents,
    vehicle: (id) => {
      const v = vehicleById.get(id);
      return v ? vehicleLabel(v) : null;
    },
    driver: (id) => {
      const d = id === null ? undefined : driverById.get(id);
      return d ? fullName(d) : null;
    },
    area: (id) => areaById.get(id)?.name ?? null,
  };
}
