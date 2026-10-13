import type { Incident } from '../../cases/src/index.js';
import { addCalendarDays } from './calendar.js';
import {
  DAY_MS,
  HOUR_MS,
  UNASSIGNED_AFTER_HOURS,
  UNASSIGNED_ESCALATION_HOURS,
  WARNING_DENOMINATOR,
  WARNING_NUMERATOR,
  type AlertKind,
  type SlaSettings,
  type SlaState,
} from './catalog.js';
import type { CycleFacts } from './types.js';

export interface Evaluation {
  readonly deadline: string;
  readonly state: SlaState;
  readonly elapsedPercent: number;
}

/**
 * Where a cycle stands at `nowMs`. The target runs from the start to `targetDays` calendar days later
 * at the same local time in the tenant's zone; 80 % is `5 * elapsed >= 4 * target`, exact in integers.
 * A resolved cycle is judged at its resolution and freezes there.
 */
export function evaluate(facts: CycleFacts, timeZone: string, nowMs: number): Evaluation {
  const start = Date.parse(facts.startedAt);
  const deadline = addCalendarDays(facts.startedAt, facts.targetDays, timeZone);
  const target = Date.parse(deadline) - start;
  const end = facts.resolvedAt === null ? null : Date.parse(facts.resolvedAt);
  const elapsed = (end ?? nowMs) - start;
  const elapsedPercent = Math.max(0, Math.floor((100 * elapsed) / target));
  const state: SlaState =
    end !== null
      ? end <= start + target
        ? 'met'
        : 'missed'
      : elapsed >= target
        ? 'breached'
        : WARNING_DENOMINATOR * elapsed >= WARNING_NUMERATOR * target
          ? 'warning'
          : 'on_track';
  return { deadline, state, elapsedPercent };
}

/** A notice the clock says is due, before it is checked against the ones that exist. */
export interface DueAlert {
  readonly kind: AlertKind;
  readonly cycle: number;
  readonly dedupeRef: string;
  readonly deadline: string | null;
}

/** Epoch milliseconds of a stored instant; a missing one is NaN, which no threshold ever passes. */
const instant = (value: string | null): number => (value === null ? Number.NaN : Date.parse(value));

/**
 * Every notice due for a watched case at `nowMs` (SPECS §7: each threshold once per cycle and target
 * version). Thresholds that were skipped are all due at once: a case first seen past its deadline owes
 * both the 80 % and the 100 % notice.
 */
export function dueAlerts(
  incident: Incident,
  facts: CycleFacts | null,
  settings: SlaSettings,
  nowMs: number,
): readonly DueAlert[] {
  const due: DueAlert[] = [];
  const at = (kind: AlertKind, dedupeRef: string, deadline: string | null = null): void => {
    due.push({ kind, cycle: incident.cycle, dedupeRef, deadline });
  };
  if (facts && facts.resolvedAt === null) {
    const { deadline, state } = evaluate(facts, settings.timeZone, nowMs);
    const ref = `t${facts.targetVersion}`;
    if (state === 'warning' || state === 'breached') at('sla_warning', ref, deadline);
    if (state === 'breached') at('sla_breach', ref, deadline);
  }
  // Wall-clock hours since the report (D17); strictly more than 4 h, and 24 h or more to escalate.
  if (incident.status === 'reported' && incident.responsibleId === null) {
    const waited = nowMs - instant(incident.reportedAt);
    const ref = `r${instant(incident.reportedAt)}`;
    if (waited > UNASSIGNED_AFTER_HOURS * HOUR_MS) at('unassigned', ref);
    if (waited >= UNASSIGNED_ESCALATION_HOURS * HOUR_MS) at('unassigned_escalation', ref);
  }
  // A change of the case restarts the reference, so a new quiet period is noticed once more.
  const quiet = nowMs - instant(incident.updatedAt);
  const stamp = `u${instant(incident.updatedAt)}`;
  if (quiet >= settings.inactivityDays * DAY_MS) at('inactive', stamp);
  if (quiet >= 2 * settings.inactivityDays * DAY_MS) at('inactive_escalation', stamp);
  return due;
}
