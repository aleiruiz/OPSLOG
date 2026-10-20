import type { BffWidgetId } from '@opslog/contracts';
import type { StatusTone } from '@opslog/ui';

export interface WidgetCopy {
  readonly title: string;
  /** What the figure counts, under the number. */
  readonly hint: string;
  /** Tone and extra words when the figure asks for attention (color is never the only signal). */
  readonly attention?: { readonly tone: StatusTone; readonly text: string };
  /** Honest note when the list the link opens is only close to the formula. */
  readonly note?: string;
}

export const WIDGET_COPY: Readonly<Record<BffWidgetId, WidgetCopy>> = {
  vehicles_active: { title: 'Vehículos activos', hint: 'En operación hoy' },
  vehicles_out_of_service: {
    title: 'Fuera de servicio',
    hint: 'Fuera de servicio o en mantenimiento hoy',
    attention: { tone: 'warning', text: 'No disponibles' },
  },
  drivers_active: { title: 'Conductores activos', hint: 'Con estatus activo hoy' },
  maintenance_upcoming: {
    title: 'Mantenimientos próximos',
    hint: 'En 15 días o 500 km o menos',
    attention: { tone: 'warning', text: 'Por atender' },
    note: 'El listado muestra las órdenes programadas.',
  },
  documents_expiring: {
    title: 'Documentos por vencer',
    hint: 'Vigentes que vencen pronto',
    attention: { tone: 'warning', text: 'Por renovar' },
  },
  insurance_expiring: {
    title: 'Seguros por vencer',
    hint: 'Pólizas vigentes que vencen pronto',
    attention: { tone: 'warning', text: 'Por renovar' },
  },
  incidents_open: {
    title: 'Siniestros abiertos',
    hint: 'Sin cerrar ni cancelar',
    attention: { tone: 'notice', text: 'En curso' },
  },
  incidents_critical: {
    title: 'Siniestros críticos',
    hint: 'Gravedad alta o crítica, o SLA vencido',
    attention: { tone: 'danger', text: 'Atención inmediata' },
    note: 'Los listados filtran por gravedad; el SLA vencido aún no es un filtro.',
  },
  availability: {
    title: 'Disponibilidad de la flota',
    hint: 'Promedio diario del periodo',
    note: 'El listado muestra la flota de hoy, no el historial del periodo.',
  },
  documents_valid_pct: {
    title: 'Documentación vigente',
    hint: 'Documentos obligatorios vigentes hoy',
  },
  insurance_valid_pct: {
    title: 'Seguros vigentes',
    hint: 'Vehículos activos con póliza que cubre hoy',
    note: 'Compara con Seguros para ver cuáles no tienen póliza.',
  },
  maintenance_on_time: {
    title: 'Mantenimiento a tiempo',
    hint: 'Preventivas cerradas en la fecha prevista o antes',
    note: 'El listado muestra todas las preventivas cerradas.',
  },
  incidents_monthly: {
    title: 'Siniestros abiertos y cerrados',
    hint: 'Reportados y cerrados por mes',
    note: 'El listado filtra por fecha del evento.',
  },
  incidents_resolution_time: {
    title: 'Tiempo de resolución',
    hint: 'Días desde el reporte hasta la resolución',
  },
  maintenance_cost: {
    title: 'Costo de mantenimiento',
    hint: 'Órdenes cerradas en el periodo, por moneda',
  },
};
