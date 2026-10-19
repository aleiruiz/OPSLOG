import { DAY_MS, dayOf, dayStart, addDays, monthOf, monthsBetween } from './calendar.js';
import type { IncidentTimelineFact, OpenCaseFact } from './ports.js';
import { median, percentile, round2 } from './stats.js';
import type { MonthlyIncidents } from './types.js';

/** Open cases with severity `high` or `critical`, or past their SLA deadline (BRD §7.1). */
export const criticalCount = (cases: readonly OpenCaseFact[]): number =>
  cases.filter(
    (item) => item.severity === 'high' || item.severity === 'critical' || item.slaBreached,
  ).length;

/** The half-open UTC window `[from, to)` of a range of company days. */
export function rangeWindow(
  from: string,
  to: string,
  timeZone: string,
): { readonly from: string; readonly to: string } {
  return {
    from: new Date(dayStart(from, timeZone)).toISOString(),
    to: new Date(dayStart(addDays(to, 1), timeZone)).toISOString(),
  };
}

export interface MonthlyResult {
  readonly months: readonly MonthlyIncidents[];
  readonly reported: number;
  readonly closed: number;
}

/** Cases reported and cases closed inside the range, by month of the company's zone. */
export function monthlyIncidents(
  facts: readonly IncidentTimelineFact[],
  range: { readonly from: string; readonly to: string },
  window: { readonly from: string; readonly to: string },
  timeZone: string,
): MonthlyResult {
  const start = Date.parse(window.from);
  const end = Date.parse(window.to);
  const inside = (instant: string | null): instant is string =>
    instant !== null && Date.parse(instant) >= start && Date.parse(instant) < end;
  const reported = new Map<string, number>();
  const closed = new Map<string, number>();
  const bump = (map: Map<string, number>, instant: string): void => {
    const month = monthOf(dayOf(instant, timeZone));
    map.set(month, (map.get(month) ?? 0) + 1);
  };
  for (const fact of facts) {
    if (inside(fact.reportedAt)) bump(reported, fact.reportedAt);
    if (inside(fact.closedAt)) bump(closed, fact.closedAt);
  }
  const months = monthsBetween(range.from, range.to).map((month) => ({
    month,
    reported: reported.get(month) ?? 0,
    closed: closed.get(month) ?? 0,
  }));
  return {
    months,
    reported: months.reduce((total, item) => total + item.reported, 0),
    closed: months.reduce((total, item) => total + item.closed, 0),
  };
}

export interface ResolutionResult {
  readonly count: number;
  readonly medianDays: number | null;
  readonly p90Days: number | null;
}

/**
 * Days from the report to the resolution of the first cycle, for the cases whose first resolution
 * falls inside the window. Median (mean of the middle pair for an even count) and nearest-rank p90.
 */
export function resolutionTime(
  facts: readonly IncidentTimelineFact[],
  window: { readonly from: string; readonly to: string },
): ResolutionResult {
  const start = Date.parse(window.from);
  const end = Date.parse(window.to);
  const days: number[] = [];
  for (const fact of facts) {
    if (fact.reportedAt === null || fact.firstResolvedAt === null) continue;
    const resolved = Date.parse(fact.firstResolvedAt);
    if (resolved < start || resolved >= end) continue;
    days.push(Math.max(0, (resolved - Date.parse(fact.reportedAt)) / DAY_MS));
  }
  if (days.length === 0) return { count: 0, medianDays: null, p90Days: null };
  return {
    count: days.length,
    medianDays: round2(median(days)),
    p90Days: round2(percentile(days, 0.9)),
  };
}
