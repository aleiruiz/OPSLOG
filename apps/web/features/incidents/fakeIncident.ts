import type { BffIncident } from '@opslog/contracts';
import { fakeEditableFields } from './fakeRules';

export const FAKE_NOW = '2026-10-13T12:00:00.000Z';
export const ME = { id: 'user-me', displayName: 'Tú' } as const;

/** A synthetic case; every field can be overridden. All data is synthetic. */
export function baseIncident(overrides: Partial<BffIncident> = {}): BffIncident {
  const status = overrides.status ?? 'draft';
  return {
    id: 'inc-001',
    folio: 'SIN-2026-000001',
    status,
    version: 1,
    cycle: 1,
    reopenCount: 0,
    type: 'collision',
    severity: null,
    vehicle: { id: 'veh-001', economicNumber: 'ECO-001', plate: 'ABC-123' },
    driver: null,
    noDriverReason: null,
    occurredAt: null,
    occurredOn: null,
    location: null,
    description: null,
    vehicleOperable: null,
    damage: { description: null, zones: [] },
    noPhotoJustification: null,
    coverage: { status: 'unknown', policy: null, alert: null },
    vehicleProposal: null,
    insurance: {
      insurerName: null,
      claimNumber: null,
      adjusterName: null,
      adjusterContact: null,
      insurerReportedOn: null,
      insurerResult: null,
      rejectionReason: null,
      appealNote: null,
      noInsuranceReason: null,
      costAssumed: null,
      assumptionApproval: null,
    },
    resolution: {
      resolutionSummary: null,
      totalLoss: null,
      vehicleStatusDecision: null,
      resolvedAt: null,
      closeApproval: null,
      closedAt: null,
      closedBy: null,
      cancelReason: null,
    },
    reportedAt: null,
    createdAt: FAKE_NOW,
    updatedAt: FAKE_NOW,
    createdBy: ME,
    responsible: null,
    reportedBy: null,
    editableFields: fakeEditableFields(status),
    allowedCommands: [],
    ...overrides,
  };
}

/** A case ready to be reported: every field of the report requirement is present. */
export const completeEvent = (overrides: Partial<BffIncident> = {}): BffIncident =>
  baseIncident({
    severity: 'medium',
    occurredAt: '2026-10-12T15:30:00.000Z',
    occurredOn: '2026-10-12',
    location: { text: 'Av. Reforma 100', latitude: null, longitude: null },
    description: 'Golpe lateral al cambiar de carril.',
    driver: { employeeId: 'emp-001', displayName: 'Ana Pérez' },
    vehicleOperable: true,
    noPhotoJustification: 'No había cámara disponible.',
    ...overrides,
  });
