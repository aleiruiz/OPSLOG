import { BFF_COVERAGE_TYPES, BFF_POLICY_STATUSES } from './insurance.js';
import { BFF_DOCUMENT_OWNER_TYPES, BFF_DOCUMENT_STATUSES } from './documents.js';
import { BFF_EMPLOYEE_KINDS, BFF_EMPLOYEE_STATUSES } from './employees.js';
import {
  BFF_INCIDENT_SEVERITIES,
  BFF_INCIDENT_SORT_FIELDS,
  BFF_INCIDENT_STATUSES,
  BFF_INCIDENT_TYPES,
} from './incidents.js';
import { BFF_VEHICLE_STATUSES } from './vehicles.js';
import type { BffWorkOrderStatus } from './work-orders.js';

/**
 * Catalog of the URL keys of the lists of BRD §14.2 (MVP-SEARCH PR 2). It is the single source of
 * truth of three things: which query-string keys a list reads and writes (so a link reproduces the
 * view and the dashboard can drill down into it), what a saved view may hold (the allowlist the
 * server validates against) and which columns a list can show. A filter or a column may require a
 * permission: a reader without it never gets it applied, not even from a shared view.
 *
 * Keys are the same in the address bar, in the API query of the list and in a saved view's
 * `filters`. Values are always strings; an absent key means "no filter".
 */
export const BFF_LIST_MODULES = [
  'vehicles',
  'employees',
  'documents',
  'insurance',
  'maintenance',
  'incidents',
] as const;
export type BffListModule = (typeof BFF_LIST_MODULES)[number];
export const isBffListModule = (value: unknown): value is BffListModule =>
  typeof value === 'string' && (BFF_LIST_MODULES as readonly string[]).includes(value);

/** Page sizes of every list (SPECS §7); `limit` is a key of every list. */
export const BFF_LIST_LIMITS = [25, 50, 100] as const;
export const BFF_LIST_DEFAULT_LIMIT = 25;
/** Saved views a user may keep per module (FR-162). */
export const BFF_VIEWS_PER_USER_AND_MODULE = 50;
export const BFF_VIEW_NAME_MAX = 80;

export type BffFilterSpec =
  /** One value of a closed set. */
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  /** Comma-separated, duplicate-free subset of a closed set (`draft,reported`). */
  | { readonly kind: 'set'; readonly values: readonly string[] }
  /** An opaque record id. */
  | { readonly kind: 'id' }
  /** `YYYY-MM-DD`, a real calendar day. */
  | { readonly kind: 'date' }
  /** `YYYY-MM`. */
  | { readonly kind: 'month' }
  /** A whole number within the bounds. */
  | { readonly kind: 'int'; readonly min: number; readonly max: number };

export type BffViewPermission = 'view_costs' | 'view_pii' | 'incidents:view_costs';

export interface BffListFilter {
  readonly spec: BffFilterSpec;
  /** Spanish name shown in the notice when the filter is dropped for lack of permission. */
  readonly label: string;
  /** The reader needs it to use this filter. */
  readonly permission?: BffViewPermission;
}

export interface BffListColumn {
  readonly key: string;
  readonly label: string;
  /** The identifying column and the actions column are always shown. */
  readonly locked?: boolean;
  readonly permission?: BffViewPermission;
}

export interface BffListModuleSpec {
  /** App path of the list. */
  readonly path: string;
  readonly label: string;
  /** Permission that opens the list; the same one the screen requires. */
  readonly access: 'view' | 'incidents:view';
  readonly filters: Readonly<Record<string, BffListFilter>>;
  /** Columns the server can order by; empty when the list has a fixed order. */
  readonly sorts: readonly string[];
  readonly columns: readonly BffListColumn[];
}

const ID = { kind: 'id' } as const;
const DATE = { kind: 'date' } as const;
const FLAG = { kind: 'enum', values: ['true'] } as const;
const year = { kind: 'int', min: 1950, max: 2100 } as const;
const km = { kind: 'int', min: 0, max: 9_999_999 } as const;
const money = { kind: 'int', min: 0, max: 999_999_999 } as const;
const filter = (
  label: string,
  spec: BffFilterSpec,
  permission?: BffViewPermission,
): BffListFilter => ({ spec, label, ...(permission ? { permission } : {}) });
const column = (
  key: string,
  label: string,
  extra: Pick<BffListColumn, 'locked' | 'permission'> = {},
): BffListColumn => ({ key, label, ...extra });

export const BFF_MAINTENANCE_STATUSES: readonly BffWorkOrderStatus[] = [
  'scheduled',
  'assigned',
  'in_progress',
  'completed',
  'closed',
  'cancelled',
];

export const BFF_LIST_CATALOG = {
  vehicles: {
    path: '/flota/vehiculos',
    label: 'Vehículos',
    access: 'view',
    filters: {
      status: filter('Estado', { kind: 'enum', values: BFF_VEHICLE_STATUSES }),
      areaId: filter('Área', ID),
      includeArchived: filter('Archivados', FLAG),
      yearFrom: filter('Año desde', year),
      yearTo: filter('Año hasta', year),
      kmFrom: filter('Kilometraje desde', km),
      kmTo: filter('Kilometraje hasta', km),
    },
    sorts: [],
    columns: [
      column('economicNumber', 'Número económico', { locked: true }),
      column('plate', 'Placa'),
      column('make', 'Marca y modelo'),
      column('year', 'Año'),
      column('areaId', 'Área'),
      column('status', 'Estado'),
      column('odometerKm', 'Odómetro'),
      column('actions', 'Acciones', { locked: true }),
    ],
  },
  employees: {
    path: '/plantilla/empleados',
    label: 'Empleados',
    access: 'view',
    filters: {
      kind: filter('Tipo', { kind: 'enum', values: BFF_EMPLOYEE_KINDS }),
      status: filter('Estatus', { kind: 'enum', values: BFF_EMPLOYEE_STATUSES }),
      areaId: filter('Área', ID),
      includeArchived: filter('Archivados', FLAG),
      hiredFrom: filter('Ingreso desde', DATE),
      hiredTo: filter('Ingreso hasta', DATE),
      licenseExpiresFrom: filter('Vigencia de licencia desde', DATE),
      licenseExpiresTo: filter('Vigencia de licencia hasta', DATE),
    },
    sorts: [],
    columns: [
      column('lastName', 'Nombre', { locked: true }),
      column('employeeNumber', 'Número de empleado'),
      column('kind', 'Tipo'),
      column('areaId', 'Área'),
      column('status', 'Estatus'),
      column('fitness', 'Aptitud'),
      column('actions', 'Acciones', { locked: true }),
    ],
  },
  documents: {
    path: '/flota/documentos',
    label: 'Documentos',
    access: 'view',
    filters: {
      ownerType: filter('Entidad', { kind: 'enum', values: BFF_DOCUMENT_OWNER_TYPES }),
      ownerId: filter('Registro', ID),
      typeCode: filter('Tipo de documento', ID),
      status: filter('Estado', { kind: 'enum', values: BFF_DOCUMENT_STATUSES }),
      includeArchived: filter('Archivados', FLAG),
      expiresFrom: filter('Vence desde', DATE),
      expiresTo: filter('Vence hasta', DATE),
    },
    sorts: [],
    columns: [
      column('title', 'Documento', { locked: true }),
      column('typeCode', 'Tipo'),
      column('ownerId', 'Pertenece a'),
      column('documentNumber', 'Número'),
      column('expiresOn', 'Vencimiento'),
      column('status', 'Estado'),
      column('actions', 'Acciones', { locked: true }),
    ],
  },
  insurance: {
    path: '/flota/seguros',
    label: 'Seguros',
    access: 'view',
    filters: {
      vehicleId: filter('Vehículo', ID),
      coverageType: filter('Cobertura', { kind: 'enum', values: BFF_COVERAGE_TYPES }),
      status: filter('Estado', { kind: 'enum', values: BFF_POLICY_STATUSES }),
      coversOn: filter('Vigente el', DATE),
      includeArchived: filter('Archivadas', FLAG),
      endsFrom: filter('Vence desde', DATE),
      endsTo: filter('Vence hasta', DATE),
    },
    sorts: [],
    columns: [
      column('insurer', 'Aseguradora', { locked: true }),
      column('policyNumber', 'Póliza'),
      column('vehicleId', 'Vehículo'),
      column('coverageType', 'Cobertura'),
      column('endsOn', 'Vence'),
      column('status', 'Estado'),
      column('actions', 'Acciones', { locked: true }),
    ],
  },
  maintenance: {
    path: '/flota/mantenimiento',
    label: 'Órdenes de mantenimiento',
    access: 'view',
    filters: {
      status: filter('Estado', { kind: 'enum', values: BFF_MAINTENANCE_STATUSES }),
      kind: filter('Tipo', { kind: 'enum', values: ['preventive', 'corrective'] }),
      vehicleId: filter('Vehículo', ID),
      month: filter('Mes programado', { kind: 'month' }),
      overdue: filter('Vencidas', FLAG),
      costFrom: filter('Costo desde', money, 'view_costs'),
      costTo: filter('Costo hasta', money, 'view_costs'),
    },
    sorts: [],
    columns: [
      column('order', 'Orden', { locked: true }),
      column('kind', 'Tipo'),
      column('vehicleId', 'Vehículo'),
      column('status', 'Estado'),
      column('scheduledDate', 'Fecha programada'),
      column('cost', 'Costo', { permission: 'view_costs' }),
    ],
  },
  incidents: {
    path: '/incidents',
    label: 'Siniestros',
    access: 'incidents:view',
    filters: {
      status: filter('Estado', { kind: 'set', values: BFF_INCIDENT_STATUSES }),
      severity: filter('Gravedad', { kind: 'enum', values: BFF_INCIDENT_SEVERITIES }),
      type: filter('Tipo', { kind: 'enum', values: BFF_INCIDENT_TYPES }),
      vehicleId: filter('Vehículo', ID),
      responsible: filter('Responsable', { kind: 'enum', values: ['me'] }),
      createdBy: filter('Creados por mí', { kind: 'enum', values: ['me'] }),
      occurredFrom: filter('Evento desde', DATE),
      occurredTo: filter('Evento hasta', DATE),
    },
    sorts: BFF_INCIDENT_SORT_FIELDS,
    columns: [
      column('folio', 'Folio', { locked: true }),
      column('occurredAt', 'Fecha del evento'),
      column('vehicle', 'Vehículo'),
      column('driver', 'Conductor'),
      column('responsible', 'Responsable'),
      column('type', 'Tipo'),
      column('severity', 'Gravedad'),
      column('status', 'Estado'),
      column('sla', 'SLA'),
      column('updatedAt', 'Días sin movimiento'),
    ],
  },
} as const satisfies Record<BffListModule, BffListModuleSpec>;

const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function isDay(value: string): boolean {
  const match = DAY.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/** Whether `value` is something the filter accepts. Pure, so the address bar and the server agree. */
export function isValidFilterValue(spec: BffFilterSpec, value: string): boolean {
  switch (spec.kind) {
    case 'enum':
      return spec.values.includes(value);
    case 'set': {
      const parts = value.split(',');
      return (
        parts.every((part) => spec.values.includes(part)) && new Set(parts).size === parts.length
      );
    }
    case 'id':
      return OPAQUE_ID.test(value);
    case 'date':
      return isDay(value);
    case 'month':
      return MONTH.test(value);
    case 'int':
      return /^\d{1,9}$/.test(value) && Number(value) >= spec.min && Number(value) <= spec.max;
  }
}

export function listModuleSpec(module: BffListModule): BffListModuleSpec {
  return BFF_LIST_CATALOG[module];
}
