import type { BffNotificationKind, BffNotificationSeverity } from '@opslog/contracts';
import type { StatusTone } from '@opslog/ui';

export const kindLabels: Readonly<Record<BffNotificationKind, string>> = {
  document_expiring: 'Documento por vencer',
  maintenance_upcoming: 'Mantenimiento próximo',
  maintenance_overdue: 'Mantenimiento vencido',
  incident_created: 'Siniestro nuevo',
  incident_status_changed: 'Cambio de estatus de siniestro',
  incident_sla: 'Plazo de siniestro',
  vehicle_out_of_service: 'Vehículo fuera de servicio',
  work_order_assigned: 'Orden de trabajo asignada',
  membership_created: 'Nuevo miembro',
  membership_role_changed: 'Cambio de rol',
  export_ready: 'Exportación lista',
  export_failed: 'Exportación fallida',
};

export const severityTone: Readonly<Record<BffNotificationSeverity, StatusTone>> = {
  info: 'neutral',
  attention: 'notice',
  important: 'warning',
  critical: 'danger',
};

export const severityLabels: Readonly<Record<BffNotificationSeverity, string>> = {
  info: 'Informativa',
  attention: 'Atención',
  important: 'Importante',
  critical: 'Crítica',
};

export const copy = {
  bell: 'Notificaciones',
  title: 'Notificaciones',
  description:
    'Avisos de tu empresa que te corresponden. Los ves aquí y, según tus preferencias, por correo.',
  preferencesLink: 'Preferencias',
  markAll: 'Marcar todas como leídas',
  markOne: 'Marcar como leída',
  unreadOnly: 'Solo sin leer',
  kindFilter: 'Tipo de aviso',
  allKinds: 'Todos',
  empty: 'No tienes notificaciones.',
  emptyUnread: 'No tienes notificaciones sin leer.',
  error: 'No pudimos cargar tus notificaciones.',
  more: 'Ver más',
  open: 'Abrir',
  unread: 'Sin leer',
  preferencesTitle: 'Preferencias de notificaciones',
  preferencesDescription:
    'Elige por qué canal quieres recibir cada tipo de aviso. Los avisos obligatorios no se pueden desactivar.',
  matrixLabel: 'Preferencias por tipo de aviso y canal',
  kind: 'Tipo de aviso',
  inApp: 'En la aplicación',
  email: 'Correo',
  mandatory: 'Obligatorio',
  mandatoryHelp: 'Es obligatorio: siempre lo recibirás en la aplicación.',
  emailUnavailable: 'Tu empresa no envía este aviso por correo.',
  save: 'Guardar preferencias',
  saved: 'Preferencias guardadas.',
  saveError: 'No pudimos guardar tus preferencias. Intenta nuevamente.',
  back: 'Volver a notificaciones',
  adminTitle: 'Reglas de la empresa',
  adminDescription: 'Qué avisos pueden enviarse por correo y si hay horario de silencio.',
  quietHours: 'Horario de silencio (22:00 a 07:00) para el correo',
  emailKinds: 'Avisos que pueden enviarse por correo',
  saveRule: 'Guardar reglas',
  ruleSaved: 'Reglas guardadas.',
  failedTitle: 'Envíos fallidos',
  failedEmpty: 'No hay envíos fallidos.',
  follow: 'Seguir',
  following: 'Siguiendo',
  followError: 'No pudimos cambiar el seguimiento. Intenta nuevamente.',
} as const;

export const unreadAnnouncement = (unread: number): string =>
  unread === 0
    ? 'Notificaciones, sin avisos nuevos'
    : unread === 1
      ? 'Notificaciones, 1 sin leer'
      : `Notificaciones, ${unread} sin leer`;

/** What the bell shows: nothing for zero, "99+" past that, so the top bar never grows. */
export const badgeText = (unread: number): string => (unread > 99 ? '99+' : String(unread));

/** Day heading of a notice (company day is not known here; the browser's zone is the reader's). */
export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function dayHeading(key: string, todayKey: string): string {
  if (key === todayKey) return 'Hoy';
  const yesterday = new Date(`${todayKey}T00:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  if (key === yesterday.toISOString().slice(0, 10)) return 'Ayer';
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${key}T00:00:00Z`));
}
