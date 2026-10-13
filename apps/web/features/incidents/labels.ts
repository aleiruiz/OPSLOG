import type {
  BffEvidenceCategory,
  BffEvidenceFileStatus,
  BffEvidenceStage,
  BffDamageZone,
  BffIncidentSeverity,
  BffIncidentStatus,
  BffIncidentTimelineEntry,
  BffIncidentType,
  BffThirdPartyKind,
} from '@opslog/contracts';
import type { StatusTone } from '@opslog/ui';
import type { IncidentCommand, InsurerResult, VehicleDecision } from './types';

/** Spanish labels for the English snake_case ids of SPECS §6.2; the state is always text, never colour alone. */
export const STATUS_LABELS: Readonly<Record<BffIncidentStatus, string>> = {
  draft: 'Borrador',
  reported: 'Reportado',
  under_review: 'En revisión',
  insurance_process: 'Con la aseguradora',
  insurance_rejected: 'Rechazado por la aseguradora',
  no_insurance: 'Sin aseguradora',
  repair: 'En reparación',
  resolved: 'Resuelto',
  closed: 'Cerrado',
  reopened: 'Reabierto',
  cancelled: 'Cancelado',
};
export const STATUS_TONES: Readonly<Record<BffIncidentStatus, StatusTone>> = {
  draft: 'neutral',
  reported: 'notice',
  under_review: 'warning',
  insurance_process: 'warning',
  insurance_rejected: 'danger',
  no_insurance: 'warning',
  repair: 'warning',
  resolved: 'success',
  closed: 'success',
  reopened: 'notice',
  cancelled: 'neutral',
};
/** States of a case that is neither a draft nor finished: the "Abiertos" quick filter. */
export const OPEN_STATUSES: readonly BffIncidentStatus[] = [
  'reported',
  'under_review',
  'insurance_process',
  'insurance_rejected',
  'no_insurance',
  'repair',
  'resolved',
  'reopened',
];

export const TYPE_LABELS: Readonly<Record<BffIncidentType, string>> = {
  collision: 'Colisión',
  rollover: 'Volcadura',
  theft_total: 'Robo total',
  theft_partial: 'Robo parcial',
  vandalism: 'Vandalismo',
  parking_damage: 'Daño en estacionamiento',
  mechanical_failure: 'Falla mecánica',
  traffic_violation: 'Infracción de tránsito',
  injury: 'Lesión',
  other: 'Otro',
};
export const SEVERITY_LABELS: Readonly<Record<BffIncidentSeverity, string>> = {
  low: 'Baja',
  medium: 'Media',
  high: 'Alta',
  critical: 'Crítica',
};
export const ZONE_LABELS: Readonly<Record<BffDamageZone, string>> = {
  front: 'Frente',
  rear: 'Parte trasera',
  left_side: 'Costado izquierdo',
  right_side: 'Costado derecho',
  roof: 'Techo',
  windshield: 'Parabrisas',
  wheels: 'Llantas',
  engine: 'Motor',
  underbody: 'Parte inferior',
  interior: 'Interior',
  cargo_area: 'Área de carga',
  other: 'Otra zona',
};
export const KIND_LABELS: Readonly<Record<BffThirdPartyKind, string>> = {
  person: 'Persona',
  vehicle: 'Vehículo',
  property: 'Propiedad',
};
export const CATEGORY_LABELS: Readonly<Record<BffEvidenceCategory, string>> = {
  photo: 'Foto',
  police_report: 'Reporte oficial',
  driver_statement: 'Declaración del conductor',
  sketch: 'Croquis',
  budget: 'Presupuesto',
  invoice: 'Factura',
  rejection_letter: 'Carta de rechazo',
  other: 'Otro documento',
};
export const STAGE_LABELS: Readonly<Record<BffEvidenceStage, string>> = {
  on_site: 'En el lugar',
  workshop: 'En taller',
  post_repair: 'Después de la reparación',
  other: 'Otra etapa',
};
/** A file in quarantine or rejected never reads as saved evidence. */
export const FILE_STATUS_LABELS: Readonly<Record<BffEvidenceFileStatus, string>> = {
  pending_upload: 'Subiendo',
  pending_scan: 'En revisión: aún no cuenta como evidencia',
  clean: 'Guardado',
  rejected: 'Rechazado por la revisión',
  missing: 'No disponible',
};
export const INSURER_RESULT_LABELS: Readonly<Record<InsurerResult, string>> = {
  pending: 'Pendiente',
  accepted: 'Aceptado',
  partial: 'Aceptado en parte',
  rejected: 'Rechazado',
};
export const VEHICLE_DECISION_LABELS: Readonly<Record<VehicleDecision, string>> = {
  active: 'Activo',
  restricted: 'Restringido',
  in_maintenance: 'En mantenimiento',
  out_of_service: 'Fuera de servicio',
  inactive: 'Inactivo',
  decommissioned: 'Dado de baja',
};

export const COMMAND_LABELS: Readonly<Record<IncidentCommand, string>> = {
  report: 'Reportar',
  assign: 'Asignar responsable',
  review: 'Iniciar revisión',
  insure: 'Pasar a la aseguradora',
  no_insurance: 'Continuar sin aseguradora',
  reject: 'Registrar rechazo',
  appeal: 'Apelar',
  approve_assumption: 'Aprobar asunción del costo',
  repair: 'Pasar a reparación',
  resolve: 'Marcar como resuelto',
  approve_close: 'Aprobar cierre',
  close: 'Cerrar caso',
  reopen: 'Reabrir caso',
  cancel: 'Cancelar caso',
};

/** Stable requirement ids returned by INC-WORKFLOW in `missingRequirements`, as instructions for the person. */
export const REQUIREMENT_LABELS: Readonly<Record<string, string>> = {
  vehicle: 'Elige el vehículo.',
  type: 'Elige el tipo de siniestro.',
  occurred_at: 'Indica la fecha y hora del evento.',
  location: 'Indica la ubicación del evento.',
  description: 'Describe lo que ocurrió.',
  severity: 'Indica la gravedad.',
  driver_or_reason: 'Elige al conductor o explica por qué no hay conductor.',
  vehicle_operable: 'Indica si el vehículo puede operar.',
  photo_or_justification:
    'Sube una foto (cuenta cuando termina la revisión) o justifica por qué no hay foto.',
  responsible: 'Asigna a una persona responsable.',
  policy_at_event: 'Elige la póliza que cubría el día del evento.',
  insurer: 'Indica la aseguradora.',
  claim_number: 'Indica el número de siniestro de la aseguradora.',
  insurer_reported_on: 'Indica el día en que se avisó a la aseguradora.',
  required_documents: 'Sube el reporte oficial y espera a que termine su revisión.',
  no_insurance_reason: 'Escribe por qué el caso sigue sin aseguradora.',
  rejection_reason: 'Escribe el motivo del rechazo.',
  rejection_letter: 'Sube la carta de rechazo de la aseguradora.',
  appeal_note: 'Escribe la nota de la apelación.',
  d20_configured: 'La empresa aún no configura el umbral de aprobación de costos.',
  repair_order_or_budget: 'Vincula una orden de reparación o sube un presupuesto revisado.',
  insurer_result: 'Registra que la aseguradora aceptó el caso, en todo o en parte.',
  cost_assumed: 'Confirma que la empresa asume el costo.',
  assumption_approval: 'Falta la aprobación de una persona supervisora para asumir el costo.',
  resolution_summary: 'Escribe el resumen de la resolución.',
  vehicle_status_decision: 'Elige en qué estado queda el vehículo.',
  repair_orders_finished: 'Termina las órdenes de reparación vinculadas.',
  repair_costs: 'Registra los costos de la reparación.',
  final_evidence: 'Sube la evidencia final: foto posterior a la reparación o factura.',
  vehicle_blocked: 'Otra causa mantiene al vehículo fuera de servicio: no puede quedar Activo.',
  resolve_origin: 'No se puede determinar la ruta que siguió el caso.',
  no_pending_evidence: 'Espera a que termine la revisión de los archivos pendientes.',
  repair_orders_closed: 'Cierra las órdenes de reparación vinculadas.',
  close_approval: 'Falta la aprobación de cierre de una persona supervisora.',
  no_costs: 'El caso tiene costos registrados: ya no puede cancelarse.',
  no_repairs: 'El caso tiene órdenes de reparación: ya no puede cancelarse.',
  reason: 'Escribe el motivo.',
};
export const requirementLabel = (id: string): string =>
  REQUIREMENT_LABELS[id] ?? 'Falta un requisito del flujo.';

/** Requirement ids that mean "a supervisor must approve first" (D20, ADR-0014). */
export const APPROVAL_REQUIREMENTS: readonly string[] = ['close_approval', 'assumption_approval'];

/** Names of the fields an edit touched, for the timeline (the server sends names only, never values). */
export const FIELD_LABELS: Readonly<Record<string, string>> = {
  vehicleId: 'vehículo',
  type: 'tipo',
  severity: 'gravedad',
  driverId: 'conductor',
  noDriverReason: 'motivo sin conductor',
  occurredAt: 'fecha y hora del evento',
  location: 'ubicación',
  description: 'descripción',
  vehicleOperable: 'si el vehículo opera',
  damage: 'daños',
  noPhotoJustification: 'justificación sin foto',
  policyId: 'póliza',
  insurerName: 'aseguradora',
  claimNumber: 'número de siniestro',
  adjusterName: 'ajustador',
  adjusterContact: 'contacto del ajustador',
  insurerReportedOn: 'día del aviso a la aseguradora',
  insurerResult: 'resultado de la aseguradora',
  rejectionReason: 'motivo del rechazo',
  appealNote: 'nota de apelación',
  noInsuranceReason: 'motivo sin aseguradora',
  resolutionSummary: 'resumen de la resolución',
  totalLoss: 'pérdida total',
  vehicleStatusDecision: 'estado del vehículo',
  costAssumed: 'asunción del costo',
};

const EVENT_TITLES: Readonly<Record<string, string>> = {
  create: 'Borrador creado',
  update: 'Datos del caso actualizados',
  coverage_none: 'Sin póliza vigente a la fecha del evento',
  third_party_added: 'Tercero agregado',
  third_party_updated: 'Tercero actualizado',
  third_party_removed: 'Tercero retirado',
  evidence_attached: 'Evidencia agregada',
  evidence_detached: 'Evidencia retirada',
  insurance_updated: 'Datos del seguro actualizados',
  resolution_updated: 'Resolución actualizada',
};

/** Title of a timeline entry: a state command with its resulting state, or an edit of the case. */
export function timelineTitle(entry: BffIncidentTimelineEntry): string {
  const event = EVENT_TITLES[entry.command];
  if (event !== undefined) return event;
  const label = COMMAND_LABELS[entry.command as IncidentCommand];
  return label === undefined ? STATUS_LABELS[entry.to] : `${label} → ${STATUS_LABELS[entry.to]}`;
}

/** The fields an entry changed, by name, for its description line. */
export function changedFieldsText(fields: readonly string[]): string | null {
  const names = fields.map((field) => FIELD_LABELS[field]).filter((name) => name !== undefined);
  return names.length === 0 ? null : `Cambió: ${names.join(', ')}.`;
}

export const YES_NO = { yes: 'Sí', no: 'No', unknown: 'Sin dato' } as const;
