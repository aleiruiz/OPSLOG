import type { Permission } from '../../identity/src/index.js';
import type { Drilldown, WidgetDefinition, WidgetId } from './types.js';

/** Thresholds of SPECS §7 for the upcoming maintenance plans. */
export const UPCOMING_DAYS = 15;
export const UPCOMING_KM = 500;

/** Statuses a case is open in: everything except `draft`, `closed` and `cancelled`. */
export const OPEN_INCIDENT_STATUSES = [
  'reported',
  'under_review',
  'insurance_process',
  'insurance_rejected',
  'no_insurance',
  'repair',
  'resolved',
  'reopened',
] as const;

const VIEW: readonly Permission[] = ['view'];
const INCIDENTS: readonly Permission[] = ['incidents:view'];
const COSTS: readonly Permission[] = ['view', 'view_costs'];

const widget = (
  id: WidgetId,
  kind: WidgetDefinition['kind'],
  scope: WidgetDefinition['scope'],
  permissions: readonly Permission[],
  formula: string,
  numerator: string | null,
  denominator: string | null,
): WidgetDefinition => ({ id, kind, scope, permissions, formula, numerator, denominator });

/** The catalog: formula, numerator, denominator, scope and permission of every widget. */
export const WIDGETS: readonly WidgetDefinition[] = [
  widget(
    'vehicles_active',
    'count',
    'today',
    VIEW,
    'Vehículos vivos en estado activo hoy.',
    'Vehículos no archivados con estado activo',
    null,
  ),
  widget(
    'vehicles_out_of_service',
    'count',
    'today',
    VIEW,
    'Vehículos vivos fuera de servicio o en mantenimiento hoy.',
    'Vehículos no archivados con estado fuera de servicio o en mantenimiento',
    null,
  ),
  widget(
    'drivers_active',
    'count',
    'today',
    VIEW,
    'Conductores activos hoy.',
    'Empleados no archivados de tipo conductor con estatus activo',
    null,
  ),
  widget(
    'maintenance_upcoming',
    'count',
    'today',
    VIEW,
    `Planes activos con próxima ocurrencia en ${UPCOMING_DAYS} días o menos, o a ${UPCOMING_KM} km o menos (vencidos incluidos).`,
    'Planes activos de vehículos vivos con fecha objetivo a 15 días o menos de hoy, o con odómetro leído a 500 km o menos del objetivo',
    null,
  ),
  widget(
    'documents_expiring',
    'count',
    'today',
    VIEW,
    'Documentos vigentes cuyo último día válido cae entre hoy y el umbral de la empresa.',
    'Documentos no archivados con vencimiento entre hoy y hoy más el umbral (inclusive)',
    null,
  ),
  widget(
    'insurance_expiring',
    'count',
    'today',
    VIEW,
    'Pólizas vigentes cuyo último día válido cae entre hoy y el umbral de la empresa.',
    'Pólizas no archivadas con fin de vigencia entre hoy y hoy más el umbral (inclusive)',
    null,
  ),
  widget(
    'incidents_open',
    'count',
    'today',
    INCIDENTS,
    'Siniestros en un estado no terminal distinto de borrador.',
    'Casos que no están en borrador, cerrados ni cancelados',
    null,
  ),
  widget(
    'incidents_critical',
    'count',
    'today',
    INCIDENTS,
    'Siniestros abiertos con severidad alta o crítica, o con el SLA vencido.',
    'Casos abiertos con severidad alta o crítica, o con el SLA vencido',
    null,
  ),
  widget(
    'availability',
    'availability',
    'range',
    VIEW,
    'Promedio, sobre los días del rango, de vehículos activos / vehículos vivos al cierre de cada día.',
    'Vehículos activos al cierre del día, según el historial de estado',
    'Vehículos vivos al cierre del día (existentes, no archivados y no dados de baja)',
  ),
  widget(
    'documents_valid_pct',
    'ratio',
    'today',
    VIEW,
    'Documentos obligatorios vigentes / documentos obligatorios, de vehículos y conductores, hoy.',
    'Pares (titular, tipo obligatorio) con un documento no archivado cuyo último día válido es hoy o posterior',
    'Vehículos vivos por tipos obligatorios de vehículo, más conductores activos por tipos obligatorios de empleado',
  ),
  widget(
    'insurance_valid_pct',
    'ratio',
    'today',
    VIEW,
    'Vehículos activos con póliza que cubre hoy / vehículos activos.',
    'Vehículos activos con una póliza no archivada cuya vigencia incluye hoy',
    'Vehículos activos',
  ),
  widget(
    'maintenance_on_time',
    'ratio',
    'range',
    VIEW,
    'Preventivas cerradas en el rango con fecha real igual o anterior a la prevista / preventivas cerradas en el rango con fecha prevista.',
    'Preventivas cerradas en el rango con fecha real igual o anterior a la fecha prevista',
    'Preventivas cerradas en el rango que tienen fecha prevista y fecha real',
  ),
  widget(
    'incidents_monthly',
    'monthly',
    'range',
    INCIDENTS,
    'Siniestros reportados en el rango y siniestros cerrados en el rango, por mes de la empresa.',
    null,
    null,
  ),
  widget(
    'incidents_resolution_time',
    'duration',
    'range',
    INCIDENTS,
    'Mediana y percentil 90 de los días entre el reporte y la resolución del primer ciclo, de los casos resueltos en el rango.',
    'Días de cada caso resuelto en el rango',
    null,
  ),
  widget(
    'maintenance_cost',
    'money',
    'range',
    COSTS,
    'Suma por moneda de los costos de las órdenes de mantenimiento cerradas en el rango; las monedas no se suman entre sí.',
    'Costos de las órdenes cerradas en el rango',
    null,
  ),
];

export const WIDGET_BY_ID: ReadonlyMap<WidgetId, WidgetDefinition> = new Map(
  WIDGETS.map((definition) => [definition.id, definition]),
);

/** Widgets whose permissions are all in `granted`, in catalog order. */
export function visibleWidgets(granted: readonly Permission[]): readonly WidgetDefinition[] {
  const held = new Set<string>(granted);
  return WIDGETS.filter((definition) => definition.permissions.every((p) => held.has(p)));
}

export interface DrilldownContext {
  readonly areaId: string | null;
  readonly from: string;
  readonly to: string;
  readonly expiryWindowDays: number;
}

/** The list each widget opens: filters in semantic names, plus the area and range that were applied. */
export function drilldownOf(id: WidgetId, context: DrilldownContext): Drilldown {
  const area = context.areaId === null ? {} : { areaId: context.areaId };
  const range = { from: context.from, to: context.to };
  const within = String(context.expiryWindowDays);
  const make = (target: Drilldown['target'], filters: Record<string, string>): Drilldown => ({
    target,
    filters: { ...filters, ...area },
  });
  switch (id) {
    case 'vehicles_active':
      return make('vehicles', { status: 'active' });
    case 'vehicles_out_of_service':
      return make('vehicles', { status: 'out_of_service,in_maintenance' });
    case 'drivers_active':
      return make('employees', { kind: 'driver', status: 'active' });
    case 'maintenance_upcoming':
      return make('maintenance', {
        view: 'upcoming',
        withinDays: String(UPCOMING_DAYS),
        withinKm: String(UPCOMING_KM),
      });
    case 'documents_expiring':
      return make('documents', { expiry: 'expiring', withinDays: within });
    case 'insurance_expiring':
      return make('insurance', { expiry: 'expiring', withinDays: within });
    case 'incidents_open':
      return make('incidents', { statuses: OPEN_INCIDENT_STATUSES.join(',') });
    case 'incidents_critical':
      return make('incidents', {
        statuses: OPEN_INCIDENT_STATUSES.join(','),
        critical: 'true',
      });
    case 'availability':
      return make('vehicle_status', range);
    case 'documents_valid_pct':
      return make('documents', { expiry: 'expired' });
    case 'insurance_valid_pct':
      return make('vehicles', { status: 'active', insurance: 'none' });
    case 'maintenance_on_time':
      return make('maintenance_orders', {
        kind: 'preventive',
        status: 'closed',
        onTime: 'false',
        closedFrom: context.from,
        closedTo: context.to,
      });
    case 'incidents_monthly':
      return make('incidents', { reportedFrom: context.from, reportedTo: context.to });
    case 'incidents_resolution_time':
      return make('reports_resolution_time', range);
    case 'maintenance_cost':
      return make('reports_costs', range);
  }
}
