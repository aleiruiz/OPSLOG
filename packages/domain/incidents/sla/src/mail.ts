import type { IncidentSeverity } from '../../cases/src/index.js';
import type { AlertKind } from './catalog.js';
import type { SlaAlert } from './types.js';

/** Fixed Spanish templates (configurable ones are MVP-NOTIFY's). Only the folio, kind, severity and link. */
export const KIND_LABELS: Readonly<Record<AlertKind, string>> = {
  assigned: 'Se te asignó el siniestro',
  sla_warning: 'El SLA del siniestro alcanzó el 80 %',
  sla_breach: 'El SLA del siniestro venció',
  unassigned: 'El siniestro lleva más de 4 horas sin responsable',
  unassigned_escalation: 'Escalación: el siniestro lleva 24 horas o más sin responsable',
  inactive: 'El siniestro no tiene movimiento',
  inactive_escalation: 'Escalación: el siniestro sigue sin movimiento',
};
export const SEVERITY_LABELS: Readonly<Record<IncidentSeverity, string>> = {
  critical: 'Crítica',
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
};

/** The message of a notice. It never carries an amount, a name, a reason or any free text of the case. */
export function composeMessage(
  alert: Pick<SlaAlert, 'folio' | 'kind' | 'severity'>,
  link: string,
): { readonly subject: string; readonly body: string } {
  const lines = [
    `Folio: ${alert.folio}`,
    `Aviso: ${KIND_LABELS[alert.kind]}`,
    ...(alert.severity === null ? [] : [`Severidad: ${SEVERITY_LABELS[alert.severity]}`]),
    `Enlace: ${link}`,
  ];
  return { subject: `OPSLOG: ${KIND_LABELS[alert.kind]} ${alert.folio}`, body: lines.join('\n') };
}
