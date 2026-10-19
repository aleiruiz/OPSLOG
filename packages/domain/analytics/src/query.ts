import { addDays, dayOf, daysBetween, isCalendarDay } from './calendar.js';
import type { CompanyParameters } from './ports.js';
import { AnalyticsError, type DashboardQuery, type ResolvedQuery } from './types.js';

/** Longest range a dashboard reads, in days. */
export const MAX_RANGE_DAYS = 366;
/** The range when the caller names none: the 30 days that end today. */
export const DEFAULT_RANGE_DAYS = 30;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_DAY = '2000-01-01';
const MAX_DAY = '2100-12-31';

function dayOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!isCalendarDay(value) || value < MIN_DAY || value > MAX_DAY)
    throw new AnalyticsError('invalid_input', field);
  return value;
}

/**
 * Validates a request and fills its defaults in the company's zone. A range is closed on both ends,
 * at most 366 days long. The area is only checked for its shape here; whether it is one of the
 * tenant's areas is answered when the dashboard is computed.
 */
export function resolveQuery(
  query: DashboardQuery,
  company: CompanyParameters,
  now: Date,
): ResolvedQuery {
  const areaRaw = query.areaId;
  if (
    areaRaw !== undefined &&
    areaRaw !== null &&
    areaRaw !== '' &&
    !(typeof areaRaw === 'string' && ID.test(areaRaw))
  )
    throw new AnalyticsError('invalid_input', 'area_id');
  const today = dayOf(now, company.timeZone);
  const givenTo = dayOrNull(query.to, 'to');
  const givenFrom = dayOrNull(query.from, 'from');
  const to = givenTo ?? (givenFrom !== null && givenFrom > today ? givenFrom : today);
  const from = givenFrom ?? addDays(to, 1 - DEFAULT_RANGE_DAYS);
  if (from > to) throw new AnalyticsError('invalid_input', 'from');
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw new AnalyticsError('invalid_input', 'to');
  return {
    areaId: typeof areaRaw === 'string' && areaRaw !== '' ? areaRaw : null,
    from,
    to,
    today,
    timeZone: company.timeZone,
    expiryWindowDays: company.expiryWindowDays,
  };
}
