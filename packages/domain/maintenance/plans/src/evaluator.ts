import { addCalendarDays, calendarDay, targets } from './rules.js';
import type { MaintenancePlan, OdometerReading, PlanEvaluation, Trigger } from './types.js';

export interface PlanScanSnapshot {
  readonly now: Date;
  readonly odometer: OdometerReading;
  readonly occurrence: number;
  readonly orderIncomplete?: boolean;
  /** IANA zone of the tenant: "today" is its calendar day. UTC when omitted. */
  readonly timeZone?: string;
}

/** Pure inclusive threshold calculation. It never creates an order inside the upcoming window. */
export function evaluatePlan(
  plan: MaintenancePlan,
  snapshot: PlanScanSnapshot,
): readonly PlanEvaluation[] {
  if (plan.state !== 'active') return [];
  const target = targets(plan);
  const today = calendarDay(snapshot.now, snapshot.timeZone);
  const dateReached = target.targetDate !== null && today >= target.targetDate;
  const kmReadingKnown = snapshot.odometer.updatedAt !== null;
  const kmReached =
    kmReadingKnown && target.targetKm !== null && snapshot.odometer.km >= target.targetKm;
  const trigger: Trigger = dateReached ? 'date' : 'odometer';
  const isDue = dateReached || kmReached;
  const odometerFacts =
    snapshot.odometer.updatedAt === null
      ? {}
      : {
          odometerLastUpdatedAt: snapshot.odometer.updatedAt,
          odometerAgeSeconds: Math.max(
            0,
            Math.floor((snapshot.now.getTime() - Date.parse(snapshot.odometer.updatedAt)) / 1000),
          ),
        };
  const base = { occurrence: snapshot.occurrence, planVersion: plan.version, ...target };
  if (isDue) {
    const results: PlanEvaluation[] = [
      {
        ...base,
        kind: 'due',
        trigger,
        threshold: 'target',
        occurredAt: snapshot.now.toISOString(),
        ...(trigger === 'odometer' ? odometerFacts : {}),
      },
    ];
    const targetPassed =
      trigger === 'date'
        ? today > (target.targetDate ?? today)
        : snapshot.odometer.km > (target.targetKm ?? snapshot.odometer.km);
    if (targetPassed && snapshot.orderIncomplete)
      results.push({
        ...base,
        kind: 'overdue',
        trigger,
        threshold: 'target',
        occurredAt: snapshot.now.toISOString(),
        ...(trigger === 'odometer' ? odometerFacts : {}),
      });
    return results;
  }
  const evaluations: PlanEvaluation[] = [];
  if (target.targetDate !== null) {
    const upcomingDate = addCalendarDays(target.targetDate, -15);
    if (today >= upcomingDate)
      evaluations.push({
        ...base,
        kind: 'upcoming',
        trigger: 'date',
        threshold: '15_days',
        occurredAt: snapshot.now.toISOString(),
      });
  }
  if (kmReadingKnown && target.targetKm !== null && target.targetKm - snapshot.odometer.km <= 500)
    evaluations.push({
      ...base,
      kind: 'upcoming',
      trigger: 'odometer',
      threshold: '500_km',
      occurredAt: snapshot.now.toISOString(),
      ...odometerFacts,
    });
  return evaluations;
}
