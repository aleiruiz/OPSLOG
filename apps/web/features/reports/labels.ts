import type { StatusTone } from '@opslog/ui';
import type {
  BffExport,
  BffExportFailure,
  BffExportStatus,
  BffReportFormat,
} from '@opslog/contracts';

export const FORMAT_LABELS: Readonly<Record<BffReportFormat, string>> = {
  csv: 'CSV (texto separado por comas)',
  xlsx: 'Excel (XLSX)',
  pdf: 'PDF',
};

export const FORMAT_SHORT: Readonly<Record<BffReportFormat, string>> = {
  csv: 'CSV',
  xlsx: 'Excel',
  pdf: 'PDF',
};

export const STATUS_VIEW: Readonly<Record<BffExportStatus, { label: string; tone: StatusTone }>> = {
  queued: { label: 'En cola', tone: 'notice' },
  running: { label: 'Generando', tone: 'notice' },
  completed: { label: 'Listo', tone: 'success' },
  failed: { label: 'Falló', tone: 'danger' },
  expired: { label: 'Vencido', tone: 'neutral' },
};

export const FAILURE_LABELS: Readonly<Record<BffExportFailure, string>> = {
  permission_revoked: 'Ya no tienes permiso para este reporte.',
  session_ended: 'Tu sesión terminó antes de generar el archivo.',
  too_many_rows:
    'El reporte tiene demasiadas filas. Acota los filtros o exporta en CSV o XLSX (el PDF admite hasta 2.000 filas).',
  generation_failed: 'No se pudo generar el archivo. Inténtalo de nuevo.',
};

export const OPEN_STATUSES: readonly BffExportStatus[] = ['queued', 'running'];
export const isOpen = (item: Pick<BffExport, 'status'>): boolean =>
  OPEN_STATUSES.includes(item.status);

export const copy = {
  title: 'Reportes',
  description:
    'Consulta los reportes de tu empresa y expórtalos. Solo ves las columnas que tu rol permite.',
  catalogTab: 'Catálogo',
  exportsTab: 'Mis exportaciones',
  open: 'Abrir reporte',
  back: 'Volver al catálogo',
  filters: 'Filtros',
  allOptions: 'Todos',
  columns: 'Columnas',
  columnsHelp: 'Elige qué columnas ver y exportar.',
  sort: 'Ordenar por',
  direction: 'Orden',
  asc: 'Ascendente',
  desc: 'Descendente',
  preview: 'Vista previa',
  noRows: 'Ningún registro coincide con los filtros.',
  noColumns: 'Elige al menos una columna.',
  previous: 'Anterior',
  next: 'Siguiente',
  format: 'Formato',
  export: 'Exportar',
  exporting: 'Exportando…',
  download: 'Descargar archivo',
  refresh: 'Actualizar',
  noExport: 'Tu rol puede consultar este reporte, pero no exportarlo.',
  exportsEmpty: 'Todavía no has exportado ningún reporte.',
  exportsHint:
    'Los archivos están disponibles 7 días. Los reportes grandes se preparan en segundo plano.',
  queuedNotice:
    'Tu reporte es grande y se está preparando. Aparecerá listo en «Mis exportaciones».',
  tooMany: 'Tienes demasiadas exportaciones en curso. Espera a que terminen e inténtalo de nuevo.',
  exportFailed: 'No se pudo iniciar la exportación. Inténtalo de nuevo.',
  loadFailed: 'No se pudo cargar el reporte.',
} as const;

export function rangeText(offset: number, shown: number, total: number): string {
  return total === 0 ? '0 de 0' : `${offset + 1}–${offset + shown} de ${total}`;
}
