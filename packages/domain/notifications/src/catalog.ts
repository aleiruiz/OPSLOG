/** The notices of OPSLOG (BRD §15.1). Ids are English snake_case; the labels are the Spanish the screens show. */
export const EVENT_KINDS = [
  'document_expiring',
  'maintenance_upcoming',
  'maintenance_overdue',
  'incident_created',
  'incident_status_changed',
  'incident_sla',
  'vehicle_out_of_service',
  'work_order_assigned',
  'membership_created',
  'membership_role_changed',
  'export_ready',
  'export_failed',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const isEventKind = (value: unknown): value is EventKind =>
  typeof value === 'string' && (EVENT_KINDS as readonly string[]).includes(value);

export const CHANNELS = ['in_app', 'email'] as const;
export type Channel = (typeof CHANNELS)[number];
export const isChannel = (value: unknown): value is Channel =>
  typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);

/** What a notice is about. Only vehicles and incidents can be followed. */
export const ENTITY_TYPES = [
  'vehicle',
  'incident',
  'work_order',
  'maintenance_plan',
  'employee',
  'export',
  'member',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];
export const SUBSCRIPTION_TYPES = ['vehicle', 'incident'] as const;
export type SubscriptionType = (typeof SUBSCRIPTION_TYPES)[number];
export const isSubscriptionType = (value: unknown): value is SubscriptionType =>
  typeof value === 'string' && (SUBSCRIPTION_TYPES as readonly string[]).includes(value);

/** Colors never carry the meaning alone: the screens pair each severity with a word. */
export const SEVERITIES = ['info', 'attention', 'important', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** The right a person needs to see a kind of notice at all (checked when it is created, sent and read). */
export type Requirement = 'view' | 'incidents' | null;

export interface KindSpec {
  readonly label: string;
  readonly description: string;
  /** A person cannot switch it off (FR-152). */
  readonly mandatory: boolean;
  /** This module sends its e-mail. `false`: another module already does (the SLA notices). */
  readonly email: boolean;
  readonly requires: Requirement;
  /** The entity type whose followers also receive it. */
  readonly followers: SubscriptionType | null;
}

export const KINDS: Readonly<Record<EventKind, KindSpec>> = {
  document_expiring: {
    label: 'Documento, seguro o licencia por vencer',
    description: 'Avisa a 30, 15 y 7 días y el día del vencimiento.',
    mandatory: false,
    email: true,
    requires: 'view',
    followers: null,
  },
  maintenance_upcoming: {
    label: 'Mantenimiento próximo',
    description: 'Un plan de mantenimiento está por cumplirse.',
    mandatory: false,
    email: true,
    requires: 'view',
    followers: null,
  },
  maintenance_overdue: {
    label: 'Mantenimiento vencido',
    description: 'Un plan de mantenimiento ya se cumplió sin orden cerrada.',
    mandatory: false,
    email: true,
    requires: 'view',
    followers: null,
  },
  incident_created: {
    label: 'Siniestro nuevo',
    description: 'Se registró un siniestro de los que sigues o te corresponden.',
    mandatory: false,
    email: true,
    requires: 'incidents',
    followers: 'incident',
  },
  incident_status_changed: {
    label: 'Cambio de estado de un siniestro',
    description: 'Un siniestro tuyo o que sigues cambió de estado.',
    mandatory: false,
    email: true,
    requires: 'incidents',
    followers: 'incident',
  },
  incident_sla: {
    label: 'Asignación y plazos de siniestros',
    description: 'Siniestro asignado, sin responsable, plazo por vencer o sin movimiento.',
    mandatory: true,
    email: false,
    requires: 'incidents',
    followers: null,
  },
  vehicle_out_of_service: {
    label: 'Vehículo fuera de servicio',
    description: 'Un vehículo pasó a fuera de servicio.',
    mandatory: false,
    email: true,
    requires: 'view',
    followers: 'vehicle',
  },
  work_order_assigned: {
    label: 'Orden de mantenimiento asignada',
    description: 'Te asignaron una orden de mantenimiento.',
    mandatory: true,
    email: true,
    requires: 'view',
    followers: null,
  },
  membership_created: {
    label: 'Usuario nuevo',
    description: 'Se creó un usuario en la empresa.',
    mandatory: true,
    email: true,
    requires: null,
    followers: null,
  },
  membership_role_changed: {
    label: 'Cambio de rol',
    description: 'Cambió el rol de un usuario de la empresa.',
    mandatory: true,
    email: true,
    requires: null,
    followers: null,
  },
  export_ready: {
    label: 'Exportación lista',
    description: 'Tu exportación ya se puede descargar.',
    mandatory: true,
    email: true,
    requires: null,
    followers: null,
  },
  export_failed: {
    label: 'Exportación fallida',
    description: 'Tu exportación no se pudo generar.',
    mandatory: true,
    email: true,
    requires: null,
    followers: null,
  },
};

/** Thresholds, in days before the due date, of the expiry notices (FR-151). `0` is the due day and after. */
export const EXPIRY_THRESHOLDS = [30, 15, 7, 0] as const;

export const MAX_TITLE = 160;
export const MAX_LINK = 200;
