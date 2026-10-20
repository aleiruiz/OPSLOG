import type { BffWebhookDeliveredEvent, BffWebhookDeliveryStatus } from '@opslog/contracts';
import type { StatusTone } from '@opslog/ui';

export const eventLabels: Readonly<Record<BffWebhookDeliveredEvent, string>> = {
  'vehicle.created': 'Vehículo creado',
  'vehicle.updated': 'Vehículo actualizado',
  'vehicle.status_changed': 'Cambio de estatus de vehículo',
  'driver.created': 'Conductor creado',
  'driver.updated': 'Conductor actualizado',
  'driver.eligibility_changed': 'Cambio de aptitud de conductor',
  'incident.created': 'Siniestro creado',
  'incident.status_changed': 'Cambio de estatus de siniestro',
  'incident.closed': 'Siniestro cerrado',
  'maintenance.created': 'Mantenimiento creado',
  'maintenance.status_changed': 'Cambio de estatus de mantenimiento',
  ping: 'Prueba',
};

export const statusLabels: Readonly<Record<BffWebhookDeliveryStatus, string>> = {
  pending: 'Pendiente',
  delivered: 'Entregada',
  failed: 'Fallida',
  dead_letter: 'Descartada',
};

export const statusTone: Readonly<Record<BffWebhookDeliveryStatus, StatusTone>> = {
  pending: 'notice',
  delivered: 'success',
  failed: 'warning',
  dead_letter: 'danger',
};

/** The error codes of an attempt, in words. The receiver's answer is never kept, so there is nothing else to show. */
export function errorLabel(code: string | null): string {
  if (code === null) return '';
  const http = /^http_(\d{3})$/.exec(code);
  if (http) return `El receptor respondió con error ${http[1]}`;
  return errorLabels[code] ?? 'Falla desconocida';
}
const errorLabels: Readonly<Record<string, string>> = {
  timeout: 'El receptor no respondió a tiempo',
  connection: 'No se pudo conectar',
  tls: 'Falló la conexión segura',
  redirect: 'El receptor redirigió (no se siguen redirecciones)',
  private_address: 'La dirección no es pública',
  host: 'La dirección no es pública',
  unresolved: 'El nombre no se resolvió',
  invalid_url: 'La dirección no es válida',
  not_https: 'La dirección debe ser https',
  credentials: 'La dirección no puede llevar usuario ni contraseña',
  port: 'Solo se permite el puerto 443',
};

export const copy = {
  title: 'Integraciones',
  description:
    'Webhooks salientes: OPSLOG envía eventos firmados a las direcciones HTTPS públicas que registres.',
  eyebrow: 'Configuración',
  add: 'Agregar endpoint',
  limit: (max: number) => `Hasta ${max} endpoints por empresa.`,
  limitReached: 'Llegaste al máximo de endpoints. Elimina uno para agregar otro.',
  emptyTitle: 'Aún no hay endpoints',
  emptyDescription: 'Agrega una dirección HTTPS para empezar a recibir eventos.',
  url: 'Dirección HTTPS',
  urlHelp: 'Solo https, puerto 443 y una dirección pública. No se siguen redirecciones.',
  events: 'Eventos',
  active: 'Activo',
  save: 'Guardar',
  cancel: 'Cancelar',
  edit: 'Editar',
  history: 'Entregas',
  test: 'Enviar prueba',
  testSent: 'Prueba enviada. Revisa el resultado en el historial.',
  rotate: 'Rotar secreto',
  remove: 'Eliminar',
  disabled: 'Desactivado por fallas',
  disabledHelp: 'Falló 20 veces seguidas. Actívalo de nuevo cuando el receptor responda.',
  inactive: 'Inactivo',
  enabled: 'Activo',
  secretTitle: 'Guarda este secreto ahora',
  secretHelp: 'No se volverá a mostrar. Úsalo para verificar la firma de cada entrega.',
  secretCopy: 'Copiar secreto',
  secretCopied: 'Secreto copiado',
  secretDone: 'Ya lo guardé',
  graceUntil: (when: string) => `El secreto anterior sigue válido hasta ${when}.`,
  rotateTitle: '¿Rotar el secreto?',
  rotateDescription:
    'Se genera un secreto nuevo. El anterior sigue firmando junto al nuevo durante 24 horas.',
  removeTitle: '¿Eliminar el endpoint?',
  removeDescription:
    'Se borran también su historial de entregas y su secreto. No se puede deshacer.',
  noEvents: 'Elige al menos un evento.',
  invalidUrl: 'La dirección no es válida o no es pública.',
  saveError: 'No se pudo guardar. Intenta de nuevo.',
  conflict: 'Alguien más cambió este endpoint. Recarga e intenta de nuevo.',
  loadError: 'No se pudieron cargar las entregas.',
  deliveriesEmpty: 'Todavía no hay entregas.',
  retry: 'Reintentar',
  retried: 'Reintento programado.',
  columns: {
    event: 'Evento',
    status: 'Estado',
    code: 'Código',
    duration: 'Duración',
    attempts: 'Intento',
    when: 'Último intento',
    error: 'Motivo',
    action: 'Acción',
  },
} as const;
