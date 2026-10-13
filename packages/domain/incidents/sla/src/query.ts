import { IncidentError, type FieldIssue } from '../../cases/src/index.js';
import { isAlertKind, type AlertKind } from './catalog.js';
import { isOpaqueId } from './events.js';

export const ALERT_LIMITS = [25, 50, 100] as const;
const QUERY_KEYS = ['kind', 'incidentId', 'limit', 'offset'];

export interface AlertQuery {
  readonly kind?: AlertKind;
  readonly incidentId?: string;
  readonly limit: 25 | 50 | 100;
  readonly offset: number;
}

/** Strict query of the notice list: an unknown key or a bad value is a 400 that names the field only. */
export function parseAlertQuery(input: unknown): AlertQuery {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new IncidentError('invalid_input');
  const fields = input as Readonly<Record<string, unknown>>;
  const issues: FieldIssue[] = Object.keys(fields)
    .filter((key) => !QUERY_KEYS.includes(key))
    .map((field) => ({ field, code: 'unknown_property' }));
  const { kind, incidentId } = fields;
  const limit = fields['limit'] ?? 25;
  const offset = fields['offset'] ?? 0;
  const invalid = (field: string) => issues.push({ field, code: 'invalid' });
  if (kind !== undefined && !isAlertKind(kind)) invalid('kind');
  if (incidentId !== undefined && !isOpaqueId(incidentId)) invalid('incidentId');
  if (!(ALERT_LIMITS as readonly unknown[]).includes(limit)) invalid('limit');
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) invalid('offset');
  if (issues.length > 0) throw new IncidentError('invalid_input', issues);
  return {
    ...(kind === undefined ? {} : { kind: kind as AlertKind }),
    ...(incidentId === undefined ? {} : { incidentId: incidentId as string }),
    limit: limit as AlertQuery['limit'],
    offset: offset as number,
  };
}
