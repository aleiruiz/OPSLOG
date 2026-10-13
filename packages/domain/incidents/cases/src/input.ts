import {
  DAMAGE_ZONES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  type DamageZone,
  type IncidentSeverity,
  type IncidentType,
} from './catalog.js';
import type { IncidentDamage, IncidentListQuery, IncidentLocation } from './types.js';
import { LIST_LIMITS, LIST_SORT_FIELDS, type IncidentSortField } from './types.js';
import {
  Issues,
  booleanField,
  enumField,
  idField,
  instantField,
  isPlainObject,
  isValidDay,
  objectOf,
  opaqueId,
  present,
  textField,
  versionField,
} from './validation.js';

export const EVENT_KEYS = [
  'vehicleId',
  'type',
  'severity',
  'driverId',
  'noDriverReason',
  'occurredAt',
  'location',
  'description',
  'vehicleOperable',
  'damage',
  'noPhotoJustification',
] as const;
/** Writable keys of a draft: the event plus the explicit choice of the covering policy. */
export const WRITABLE_KEYS = [...EVENT_KEYS, 'policyId'] as const;
export type WritableKey = (typeof WRITABLE_KEYS)[number];

export const MAX_ZONES = DAMAGE_ZONES.length;
export const LIMITS = {
  location: 300,
  description: 4000,
  damage: 2000,
  noDriverReason: 300,
  noPhotoJustification: 500,
} as const;

/** The fields a request sets; absent means unchanged, `null` clears a nullable field. */
export interface EventChanges {
  readonly vehicleId?: string;
  readonly type?: IncidentType;
  readonly severity?: IncidentSeverity | null;
  readonly driverId?: string | null;
  readonly noDriverReason?: string | null;
  readonly occurredAt?: string | null;
  readonly location?: IncidentLocation | null;
  readonly description?: string | null;
  readonly vehicleOperable?: boolean | null;
  readonly damage?: IncidentDamage;
  readonly noPhotoJustification?: string | null;
  readonly policyId?: string | null;
}

function parseLocation(issues: Issues, value: unknown): IncidentLocation | null | undefined {
  if (value === null) return null;
  if (!isPlainObject(value)) return issues.add('location', 'invalid');
  const nested = new Issues();
  const data = objectOf(value, ['text', 'latitude', 'longitude'], nested);
  const text = textField(nested, 'text', data['text'], LIMITS.location, false);
  const coordinate = (key: 'latitude' | 'longitude', limit: number): number | null | undefined => {
    const raw = data[key];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > limit)
      return nested.add(key, 'invalid');
    // Six decimals is what the column keeps (about 0.1 m).
    return Math.round(raw * 1e6) / 1e6;
  };
  const latitude = coordinate('latitude', 90);
  const longitude = coordinate('longitude', 180);
  if ((latitude === null) !== (longitude === null)) nested.add('longitude', 'conflict');
  if (nested.any || text === undefined || text === null) return issues.add('location', 'invalid');
  return { text, latitude: latitude ?? null, longitude: longitude ?? null };
}

function parseDamage(issues: Issues, value: unknown): IncidentDamage | undefined {
  if (!isPlainObject(value)) return issues.add('damage', 'invalid');
  const nested = new Issues();
  const data = objectOf(value, ['description', 'zones'], nested);
  const description = present(data, 'description')
    ? textField(nested, 'description', data['description'], LIMITS.damage)
    : null;
  let zones: DamageZone[] = [];
  if (present(data, 'zones')) {
    const raw = data['zones'];
    if (
      !Array.isArray(raw) ||
      raw.length > MAX_ZONES ||
      raw.some((zone) => !(DAMAGE_ZONES as readonly unknown[]).includes(zone)) ||
      new Set(raw).size !== raw.length
    )
      nested.add('zones', 'invalid');
    else
      zones = [...(raw as DamageZone[])].sort(
        (a, b) => DAMAGE_ZONES.indexOf(a) - DAMAGE_ZONES.indexOf(b),
      );
  }
  if (nested.any || description === undefined) return issues.add('damage', 'invalid');
  return { description, zones };
}

/** Parses the writable fields present in `data`; problems go to `issues`. */
function eventChanges(data: Record<string, unknown>, issues: Issues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const take = (key: WritableKey, parse: (value: unknown) => unknown) => {
    if (!present(data, key)) return;
    const parsed = parse(data[key]);
    if (parsed !== undefined) out[key] = parsed;
  };
  take('vehicleId', (v) => idField(issues, 'vehicleId', v));
  take('type', (v) => enumField(issues, 'type', v, INCIDENT_TYPES));
  take('severity', (v) => enumField(issues, 'severity', v, INCIDENT_SEVERITIES, true));
  take('driverId', (v) => idField(issues, 'driverId', v, true));
  take('noDriverReason', (v) => textField(issues, 'noDriverReason', v, LIMITS.noDriverReason));
  take('occurredAt', (v) => instantField(issues, 'occurredAt', v));
  take('location', (v) => parseLocation(issues, v));
  take('description', (v) => textField(issues, 'description', v, LIMITS.description));
  take('vehicleOperable', (v) => booleanField(issues, 'vehicleOperable', v));
  take('damage', (v) => parseDamage(issues, v));
  take('noPhotoJustification', (v) =>
    textField(issues, 'noPhotoJustification', v, LIMITS.noPhotoJustification),
  );
  take('policyId', (v) => idField(issues, 'policyId', v, true));
  return out;
}

/** A driver or a reason for having none, never both (the report needs one of them). */
function exclusiveDriver(out: Record<string, unknown>, issues: Issues): void {
  if (typeof out['driverId'] === 'string' && typeof out['noDriverReason'] === 'string')
    issues.add('noDriverReason', 'conflict');
}

/** Minimum draft (FR-110): the vehicle and the type; every other field may be missing. */
export function parseCreate(input: unknown): EventChanges {
  const issues = new Issues();
  const data = objectOf(input, WRITABLE_KEYS, issues);
  for (const required of ['vehicleId', 'type'] as const)
    if (!present(data, required)) issues.add(required, 'required');
  const out = eventChanges(data, issues);
  exclusiveDriver(out, issues);
  issues.throwIfAny();
  return out as EventChanges;
}

export function parseUpdate(input: unknown): { version: number; changes: EventChanges } {
  const issues = new Issues();
  const data = objectOf(input, ['version', ...WRITABLE_KEYS], issues);
  if (!present(data, 'version')) issues.add('version', 'required');
  const version = present(data, 'version') ? versionField(issues, data['version']) : undefined;
  const out = eventChanges(data, issues);
  if (Object.keys(out).length === 0 && !issues.any) issues.add('body', 'required');
  exclusiveDriver(out, issues);
  issues.throwIfAny();
  return { version: version as number, changes: out as EventChanges };
}

export interface ListInput {
  readonly status?: unknown;
  readonly severity?: unknown;
  readonly type?: unknown;
  readonly vehicleId?: unknown;
  readonly responsible?: unknown;
  readonly createdBy?: unknown;
  readonly occurredFrom?: unknown;
  readonly occurredTo?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}
const LIST_KEYS = [
  'status',
  'severity',
  'type',
  'vehicleId',
  'responsible',
  'createdBy',
  'occurredFrom',
  'occurredTo',
  'sort',
  'direction',
  'limit',
  'offset',
] as const;

/** Parses the list request; `me` filters resolve to the caller. */
export function parseListQuery(input: unknown, actor: { readonly id: string }): IncidentListQuery {
  const issues = new Issues();
  const data = objectOf(input ?? {}, LIST_KEYS, issues);
  const filter: Record<string, unknown> = {};
  if (present(data, 'status')) {
    const raw = Array.isArray(data['status']) ? data['status'] : [data['status']];
    if (
      raw.length === 0 ||
      raw.length > INCIDENT_STATUSES.length ||
      raw.some((value) => !(INCIDENT_STATUSES as readonly unknown[]).includes(value))
    )
      issues.add('status', 'invalid');
    else filter['statuses'] = [...new Set(raw)];
  }
  if (present(data, 'severity'))
    filter['severity'] = enumField(issues, 'severity', data['severity'], INCIDENT_SEVERITIES);
  if (present(data, 'type'))
    filter['type'] = enumField(issues, 'type', data['type'], INCIDENT_TYPES);
  if (present(data, 'vehicleId'))
    filter['vehicleId'] = idField(issues, 'vehicleId', data['vehicleId']);
  if (present(data, 'responsible'))
    data['responsible'] === 'me'
      ? (filter['responsibleId'] = actor.id)
      : issues.add('responsible', 'invalid');
  if (present(data, 'createdBy'))
    data['createdBy'] === 'me'
      ? (filter['createdBy'] = actor.id)
      : issues.add('createdBy', 'invalid');
  for (const key of ['occurredFrom', 'occurredTo'] as const)
    if (present(data, key))
      isValidDay(data[key]) ? (filter[key] = data[key]) : issues.add(key, 'invalid');
  if (
    typeof filter['occurredFrom'] === 'string' &&
    typeof filter['occurredTo'] === 'string' &&
    filter['occurredFrom'] > filter['occurredTo']
  )
    issues.add('occurredTo', 'invalid');
  const sort = present(data, 'sort')
    ? enumField<IncidentSortField>(issues, 'sort', data['sort'], LIST_SORT_FIELDS)
    : 'createdAt';
  const direction = present(data, 'direction')
    ? enumField(issues, 'direction', data['direction'], ['asc', 'desc'] as const)
    : 'desc';
  const limit = present(data, 'limit') ? data['limit'] : 25;
  if (!(LIST_LIMITS as readonly unknown[]).includes(limit)) issues.add('limit', 'invalid');
  const offset = present(data, 'offset') ? data['offset'] : 0;
  if (!Number.isInteger(offset) || (offset as number) < 0 || (offset as number) > 1_000_000)
    issues.add('offset', 'invalid');
  issues.throwIfAny();
  return {
    filter: Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined)),
    sort: sort as IncidentSortField,
    direction: direction as 'asc' | 'desc',
    limit: limit as 25 | 50 | 100,
    offset: offset as number,
  };
}

export function parseSuggestionQuery(input: unknown): { vehicleId: string; occurredAt: string } {
  const issues = new Issues();
  const data = objectOf(input, ['vehicleId', 'occurredAt'], issues);
  for (const key of ['vehicleId', 'occurredAt'] as const)
    if (!present(data, key)) issues.add(key, 'required');
  const vehicleId = present(data, 'vehicleId') ? opaqueId(data['vehicleId']) : undefined;
  if (present(data, 'vehicleId') && vehicleId === undefined) issues.add('vehicleId', 'invalid');
  const occurredAt = present(data, 'occurredAt')
    ? instantField(issues, 'occurredAt', data['occurredAt'], false)
    : undefined;
  issues.throwIfAny();
  return { vehicleId: vehicleId as string, occurredAt: occurredAt as string };
}
