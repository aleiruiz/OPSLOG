import { createHash } from 'node:crypto';
import { normalizeKey } from './normalize.js';
import type {
  EntityProjection,
  SearchEntityType,
  SearchEntry,
  SearchKeyKind,
  SearchPermission,
} from './types.js';

/** The facts of each module the projection needs, so this package never imports a module. */
export interface VehicleFacts {
  readonly id: string;
  readonly areaId: string;
  readonly economicNumber: string;
  readonly plate: string;
  readonly vin: string | null;
  readonly make: string;
  readonly model: string;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}
export interface EmployeeFacts {
  readonly id: string;
  readonly kind: string;
  readonly areaId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly employeeNumber: string | null;
  /** Blind indexes already stored by the employees module; the values stay sealed. */
  readonly nationalIdIndex: string | null;
  readonly licenseIndex: string | null;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}
export interface IncidentFacts {
  readonly id: string;
  readonly areaId: string;
  readonly folio: string;
  readonly claimNumber: string | null;
  readonly updatedAt: string;
}
export interface PolicyFacts {
  readonly id: string;
  readonly policyNumber: string;
  readonly insurer: string;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}

interface Row {
  readonly keyKind: SearchKeyKind;
  readonly normalized: string;
  readonly requiredPermission: SearchPermission;
}

const MAX_KEY = 128;

/** The fingerprint covers what is written, not when: a rewrite of the same facts changes nothing. */
function projection(
  tenantId: string,
  entityType: SearchEntityType,
  entityId: string,
  areaId: string | null,
  display: string,
  updatedAt: string,
  rows: readonly Row[],
): EntityProjection {
  const seen = new Set<string>();
  const entries: SearchEntry[] = [];
  for (const row of rows) {
    if (row.normalized.length === 0 || row.normalized.length > MAX_KEY) continue;
    const key = `${row.keyKind}\u0000${row.normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ tenantId, entityType, entityId, areaId, display, updatedAt, ...row });
  }
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        areaId,
        display,
        entries.map((e) => [e.keyKind, e.normalized, e.requiredPermission]),
      ]),
    )
    .digest('hex');
  return { entityType, entityId, fingerprint, entries };
}

const plain = (keyKind: SearchKeyKind, text: string | null): Row[] =>
  text === null ? [] : [{ keyKind, normalized: normalizeKey(text), requiredPermission: 'view' }];

/** A live vehicle is found by its number, plate and VIN; an archived one is not searchable. */
export function vehicleProjection(tenantId: string, v: VehicleFacts): EntityProjection | null {
  if (v.archivedAt !== null) return null;
  return projection(
    tenantId,
    'vehicle',
    v.id,
    v.areaId,
    `${v.economicNumber} · ${v.plate} · ${v.make} ${v.model}`,
    v.updatedAt,
    [
      ...plain('economic_number', v.economicNumber),
      ...plain('plate', v.plate),
      ...plain('vin', v.vin),
    ],
  );
}

/**
 * A driver or dispatcher is found by name and number; identification and license only by the blind
 * index of the exact value, and only for a reader with `view_pii`. Other kinds are not searchable.
 */
export function employeeProjection(tenantId: string, e: EmployeeFacts): EntityProjection | null {
  if (e.archivedAt !== null || (e.kind !== 'driver' && e.kind !== 'dispatcher')) return null;
  const exact = (keyKind: SearchKeyKind, index: string | null): Row[] =>
    index === null ? [] : [{ keyKind, normalized: index, requiredPermission: 'view_pii' }];
  return projection(tenantId, e.kind, e.id, e.areaId, `${e.firstName} ${e.lastName}`, e.updatedAt, [
    ...plain('name', `${e.firstName}${e.lastName}`),
    ...plain('name', `${e.lastName}${e.firstName}`),
    ...plain('employee_number', e.employeeNumber),
    ...exact('identification_hmac', e.nationalIdIndex),
    ...exact('license', e.licenseIndex),
  ]);
}

/** An incident is found by folio and, once it has one, by the insurer's claim number. */
export function incidentProjection(tenantId: string, i: IncidentFacts): EntityProjection {
  const incident = (keyKind: SearchKeyKind, text: string): Row => ({
    keyKind,
    normalized: normalizeKey(text),
    requiredPermission: 'incidents:view',
  });
  return projection(tenantId, 'incident', i.id, i.areaId, `Siniestro ${i.folio}`, i.updatedAt, [
    incident('folio', i.folio),
    ...(i.claimNumber === null ? [] : [incident('claim_number', i.claimNumber)]),
  ]);
}

export function policyProjection(tenantId: string, p: PolicyFacts): EntityProjection | null {
  if (p.archivedAt !== null) return null;
  return projection(
    tenantId,
    'policy',
    p.id,
    null,
    `Póliza ${p.policyNumber} · ${p.insurer}`,
    p.updatedAt,
    plain('policy_number', p.policyNumber),
  );
}
