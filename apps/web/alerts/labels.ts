import type { StatusTone } from '@opslog/ui';
import { documentPath } from '../documents/DocumentMessages';
import { typeLabel } from '../documents/labels';
import { policyPath } from '../insurance/PolicyMessages';
import { coverageLabel } from '../insurance/labels';
import {
  BFF_ALERT_RECIPIENT_ROLES,
  BFF_ALERT_SEVERITIES,
  BFF_ALERT_SOURCES,
} from '@opslog/contracts';
import type {
  Alert,
  AlertRecipientRole,
  AlertSettings,
  AlertSeverity,
  AlertSource,
} from '../app/types';

export { expiryNote, formatDate, formatDateTime } from '../documents/labels';

export const alertsPath = '/flota/alertas';
export const alertSettingsPath = '/configuracion/alertas';

export const sourceOrder: readonly AlertSource[] = BFF_ALERT_SOURCES;
export const severityOrder: readonly AlertSeverity[] = BFF_ALERT_SEVERITIES;

/** What an alert is about; the technical ids never reach the screen. */
export const sourceLabels: Record<AlertSource, string> = {
  vehicle_document: 'Documento de vehículo',
  insurance_policy: 'Seguro',
};

export const sourceChoiceLabels: Record<AlertSource, string> = {
  vehicle_document: 'Documentos de vehículo',
  insurance_policy: 'Seguros',
};

export const severityPresentation: Record<AlertSeverity, { label: string; tone: StatusTone }> = {
  expiring: { label: 'Por vencer', tone: 'warning' },
  expired: { label: 'Vencido', tone: 'danger' },
};

/** The kind of document or the coverage of the policy; an unknown code (a newer backend) is shown generically. */
export const alertTitle = (alert: Pick<Alert, 'source' | 'typeCode'>): string =>
  alert.source === 'vehicle_document'
    ? typeLabel('vehicle', alert.typeCode)
    : coverageLabel(alert.typeCode);

/** The record that raised the alert (the document or the policy). */
export const alertRecordPath = (alert: Pick<Alert, 'source' | 'subjectId'>): string =>
  alert.source === 'vehicle_document' ? documentPath(alert.subjectId) : policyPath(alert.subjectId);

export const recipientLabels: Record<AlertRecipientRole, string> = {
  admin: 'Administración de la empresa',
  editor: 'Responsable de flotilla',
  viewer: 'Consulta',
  auditor: 'Auditoría',
  pii_reader: 'Lectura de datos personales',
};

export const recipientOrder: readonly AlertRecipientRole[] = BFF_ALERT_RECIPIENT_ROLES;

export const recipientSummary = (settings: Pick<AlertSettings, 'recipientRoles'>): string =>
  settings.recipientRoles.map((role) => recipientLabels[role]).join(', ');
