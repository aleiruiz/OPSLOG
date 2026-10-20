import { BFF_LIST_LIMITS, isValidFilterValue } from '@opslog/contracts';
import type { BffIncidentSeverity, BffIncidentType, BffIncidentsQuery } from '@opslog/contracts';
import { parseSort, sortText } from '../search/views/urlState';
import { OPEN_STATUSES } from './labels';

export const SIZES = BFF_LIST_LIMITS;
export type Size = (typeof SIZES)[number];

/** Filters as the address keeps them (keys of `BFF_LIST_CATALOG.incidents`), so a link or a reload shows the same list. */
export interface Filters {
  readonly status: string;
  readonly severity: string;
  readonly type: string;
  readonly responsible: boolean;
  readonly createdBy: boolean;
  /** The vehicle sheet's "Siniestros" link: only the cases of that vehicle. */
  readonly vehicleId: string;
  /** `YYYY-MM-DD` in the company's zone, inclusive. */
  readonly occurredFrom: string;
  readonly occurredTo: string;
  /** `campo` ascending or `-campo` descending; empty is the default, newest event first. */
  readonly sort: string;
  readonly limit: Size;
}
export const NONE: Filters = {
  status: '',
  severity: '',
  type: '',
  responsible: false,
  createdBy: false,
  vehicleId: '',
  occurredFrom: '',
  occurredTo: '',
  sort: '',
  limit: 25,
};
export const OPEN = OPEN_STATUSES.join(',');

export const QUICK: readonly { readonly label: string; readonly filters: Partial<Filters> }[] = [
  { label: 'Mis casos', filters: { responsible: true } },
  { label: 'Mis borradores', filters: { createdBy: true, status: 'draft' } },
  { label: 'Críticos', filters: { severity: 'critical' } },
  { label: 'Abiertos', filters: { status: OPEN } },
];

export const SORT_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: 'Evento más reciente primero' },
  { value: 'occurredAt', label: 'Evento más antiguo primero' },
  { value: '-createdAt', label: 'Registro más reciente primero' },
  { value: 'createdAt', label: 'Registro más antiguo primero' },
  { value: 'folio', label: 'Folio ascendente' },
  { value: '-folio', label: 'Folio descendente' },
  { value: 'severity', label: 'Gravedad ascendente' },
  { value: '-severity', label: 'Gravedad descendente' },
];

const day = (value: string | null): string =>
  value && isValidFilterValue({ kind: 'date' }, value) ? value : '';

export function readFilters(search: URLSearchParams): Filters {
  const limit = Number(search.get('limit'));
  return {
    status: search.get('status') ?? '',
    severity: search.get('severity') ?? '',
    type: search.get('type') ?? '',
    responsible: search.get('responsible') === 'me',
    createdBy: search.get('createdBy') === 'me',
    vehicleId: search.get('vehicleId') ?? '',
    occurredFrom: day(search.get('occurredFrom')),
    occurredTo: day(search.get('occurredTo')),
    sort: sortText(parseSort('incidents', search.get('sort'))),
    limit: SIZES.find((size) => size === limit) ?? 25,
  };
}
export function toQuery(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.severity) params.set('severity', filters.severity);
  if (filters.type) params.set('type', filters.type);
  if (filters.responsible) params.set('responsible', 'me');
  if (filters.createdBy) params.set('createdBy', 'me');
  if (filters.vehicleId) params.set('vehicleId', filters.vehicleId);
  if (filters.occurredFrom) params.set('occurredFrom', filters.occurredFrom);
  if (filters.occurredTo) params.set('occurredTo', filters.occurredTo);
  if (filters.sort) params.set('sort', filters.sort);
  if (filters.limit !== 25) params.set('limit', String(filters.limit));
  const text = params.toString();
  return text ? `?${text}` : '';
}
export const sameQuick = (filters: Filters, quick: Partial<Filters>): boolean =>
  (Object.keys(quick) as (keyof Filters)[]).every((key) => filters[key] === quick[key]);

export function apiQuery(filters: Filters, cursor?: string): BffIncidentsQuery {
  const sort = parseSort('incidents', filters.sort) ?? { field: 'occurredAt', direction: 'desc' };
  return {
    limit: filters.limit,
    ...(cursor ? { cursor } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.severity ? { severity: filters.severity as BffIncidentSeverity } : {}),
    ...(filters.type ? { type: filters.type as BffIncidentType } : {}),
    ...(filters.responsible ? { responsible: 'me' as const } : {}),
    ...(filters.createdBy ? { createdBy: 'me' as const } : {}),
    ...(filters.vehicleId ? { vehicleId: filters.vehicleId } : {}),
    ...(filters.occurredFrom ? { occurredFrom: filters.occurredFrom } : {}),
    ...(filters.occurredTo ? { occurredTo: filters.occurredTo } : {}),
    sort: sort.field as NonNullable<BffIncidentsQuery['sort']>,
    direction: sort.direction,
  };
}

/** Turning a quick filter off restores the defaults of the fields it set. */
export function undoQuick(quick: Partial<Filters>): Partial<Filters> {
  const reset: Record<string, unknown> = {};
  for (const name of Object.keys(quick)) reset[name] = NONE[name as keyof Filters];
  return reset as Partial<Filters>;
}
