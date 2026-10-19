import type { BffDashboardWidget, BffListModule } from '@opslog/contracts';
import { listLink } from '../search/views/urlState';

export interface DrilldownLink {
  readonly label: string;
  readonly to: string;
}

/**
 * Drill-down of each widget: the semantic filters of the payload mapped to the URL keys of the list
 * (docs/traceability/search.md). `listLink` leaves out what a list does not accept, so a link never
 * carries a key the list would ignore. Where the list has no key for the exact formula (SLA vencido,
 * próximos por km, puntualidad) the link opens the closest filtered list and the card says so.
 * Widgets whose destination is a report (REPORTS) have no link yet.
 */
export function drilldownLinks(widget: BffDashboardWidget): readonly DrilldownLink[] {
  const { filters } = widget.drilldown;
  const area = filters['areaId'] ? { areaId: filters['areaId'] } : {};
  const to = (module: BffListModule, extra: Record<string, string>) =>
    listLink(module, { ...area, ...extra });
  switch (widget.id) {
    case 'vehicles_active':
      return [{ label: 'Ver vehículos activos', to: to('vehicles', { status: 'active' }) }];
    case 'vehicles_out_of_service':
      return [
        {
          label: 'Ver fuera de servicio',
          to: to('vehicles', { status: 'out_of_service' }),
        },
        { label: 'Ver en mantenimiento', to: to('vehicles', { status: 'in_maintenance' }) },
      ];
    case 'drivers_active':
      return [
        {
          label: 'Ver conductores activos',
          to: to('employees', { kind: 'driver', status: 'active' }),
        },
      ];
    case 'maintenance_upcoming':
      return [
        { label: 'Ver mantenimientos programados', to: to('maintenance', { status: 'scheduled' }) },
      ];
    case 'documents_expiring':
      return [{ label: 'Ver documentos por vencer', to: to('documents', { status: 'expiring' }) }];
    case 'insurance_expiring':
      return [{ label: 'Ver seguros por vencer', to: to('insurance', { status: 'expiring' }) }];
    case 'incidents_open':
      return [
        {
          label: 'Ver siniestros abiertos',
          to: to('incidents', { status: filters['statuses'] ?? '' }),
        },
      ];
    case 'incidents_critical':
      return [
        {
          label: 'Ver críticos',
          to: to('incidents', { status: filters['statuses'] ?? '', severity: 'critical' }),
        },
        {
          label: 'Ver de gravedad alta',
          to: to('incidents', { status: filters['statuses'] ?? '', severity: 'high' }),
        },
      ];
    case 'availability':
      return [{ label: 'Ver estado de la flota', to: to('vehicles', {}) }];
    case 'documents_valid_pct':
      return [{ label: 'Ver documentos vencidos', to: to('documents', { status: 'expired' }) }];
    case 'insurance_valid_pct':
      return [{ label: 'Ver vehículos activos', to: to('vehicles', { status: 'active' }) }];
    case 'maintenance_on_time':
      return [
        {
          label: 'Ver preventivas cerradas',
          to: to('maintenance', { kind: 'preventive', status: 'closed' }),
        },
      ];
    case 'incidents_monthly':
      return [
        {
          label: 'Ver siniestros del periodo',
          to: to('incidents', {
            occurredFrom: filters['reportedFrom'] ?? '',
            occurredTo: filters['reportedTo'] ?? '',
          }),
        },
      ];
    case 'incidents_resolution_time':
    case 'maintenance_cost':
      return [];
  }
}
