import type { StatusTone } from '@opslog/ui';
import type { BffMaintenanceAlert } from '@opslog/contracts';
import { formatDate, formatKm } from './labels';

type Kind = BffMaintenanceAlert['kind'];

/** SPECS §7 maintenance alerts: fixed thresholds, no tenant setting. */
export const ALERT_KIND_LABELS: Readonly<Record<Kind, { label: string; tone: StatusTone }>> = {
  upcoming: { label: 'Próximo', tone: 'notice' },
  due: { label: 'Toca servicio', tone: 'warning' },
  overdue: { label: 'Vencido', tone: 'danger' },
};

export function alertReason(alert: BffMaintenanceAlert): string {
  if (alert.kind === 'upcoming')
    return alert.threshold === '500_km'
      ? 'Faltan 500 km o menos para el servicio.'
      : 'Faltan 15 días o menos para el servicio.';
  if (alert.kind === 'due') return 'Se alcanzó el objetivo; se generó la orden preventiva.';
  return 'El objetivo ya pasó y el servicio sigue sin completarse.';
}

export const alertTarget = (alert: BffMaintenanceAlert): string =>
  alert.trigger === 'odometer' ? `${formatKm(alert.targetKm)}` : `${formatDate(alert.targetDate)}`;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** How old the odometer reading was when the alert was detected; only odometer alerts carry it. */
export function odometerAge(alert: BffMaintenanceAlert): string | null {
  if (alert.trigger !== 'odometer') return null;
  const seconds = alert.odometerAgeSeconds;
  if (seconds === null) return 'Sin fecha de la lectura del odómetro';
  const age =
    seconds < 60
      ? 'menos de un minuto'
      : seconds < 3600
        ? plural(Math.floor(seconds / 60), 'minuto', 'minutos')
        : seconds < 86_400
          ? plural(Math.floor(seconds / 3600), 'hora', 'horas')
          : plural(Math.floor(seconds / 86_400), 'día', 'días');
  return `Lectura del odómetro de hace ${age}`;
}
