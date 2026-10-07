import { describe, expect, it } from 'vitest';
import { makeAlert, makeSettings, demoAlerts } from './fixtures';
import {
  alertRecordPath,
  alertTitle,
  recipientLabels,
  recipientOrder,
  recipientSummary,
  severityPresentation,
  sourceLabels,
} from './labels';

describe('alert labels', () => {
  it('names the kind of document or the coverage, and falls back generically for an unknown code', () => {
    expect(alertTitle(makeAlert({ typeCode: 'transport_permit' }))).toBe('Permiso de transporte');
    expect(alertTitle(makeAlert({ source: 'insurance_policy', typeCode: 'comprehensive' }))).toBe(
      'Todo riesgo',
    );
    expect(alertTitle(makeAlert({ typeCode: 'from_a_newer_backend' }))).toBe('Otro documento');
    expect(alertTitle(makeAlert({ source: 'insurance_policy', typeCode: 'new_cover' }))).toBe(
      'Otra cobertura',
    );
  });

  it('links to the record that raised the alert, encoding its id', () => {
    expect(alertRecordPath(makeAlert({ subjectId: 'doc-007' }))).toBe('/flota/documentos/doc-007');
    expect(alertRecordPath(makeAlert({ source: 'insurance_policy', subjectId: 'p/1' }))).toBe(
      '/flota/seguros/p%2F1',
    );
  });

  it('has a Spanish label for every source, severity and recipient role', () => {
    expect(Object.values(sourceLabels)).toEqual(['Documento de vehículo', 'Seguro']);
    expect(severityPresentation.expiring).toEqual({ label: 'Por vencer', tone: 'warning' });
    expect(severityPresentation.expired).toEqual({ label: 'Vencido', tone: 'danger' });
    for (const role of recipientOrder)
      expect(recipientLabels[role]).not.toMatch(/_|^admin$|^editor$/);
    expect(recipientSummary(makeSettings({ recipientRoles: ['admin', 'viewer'] }))).toBe(
      'Administración de la empresa, Consulta',
    );
  });

  it('builds synthetic alerts that cover both sources and both severities', () => {
    const alerts = demoAlerts(8);
    expect(new Set(alerts.map((alert) => alert.source)).size).toBe(2);
    expect(new Set(alerts.map((alert) => alert.severity)).size).toBe(2);
    expect(
      alerts.every((alert) => alert.key === `${alert.source}:${alert.subjectId}:${alert.dueOn}`),
    ).toBe(true);
  });
});
