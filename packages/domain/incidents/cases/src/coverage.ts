import type { AssignmentRef, DriverRef, PolicyRevisionRef } from './ports.js';
import { ASSIGNMENT_ORDER, type CoverageStatus } from './catalog.js';
import { IncidentError, RULES } from './errors.js';
import type { PolicySnapshot } from './types.js';

/** Insurance rule (`coversOn`): both ends of the period are inclusive. */
const covers = (revision: PolicyRevisionRef, day: string): boolean =>
  revision.startsOn <= day && day <= revision.endsOn;

const snapshotOf = (revision: PolicyRevisionRef): PolicySnapshot => ({
  policyId: revision.policyId,
  revision: revision.revision,
  insurer: revision.insurer,
  policyNumber: revision.policyNumber,
  coverageType: revision.coverageType,
  startsOn: revision.startsOn,
  endsOn: revision.endsOn,
});

/** The revision of each policy that covered the day (the newest one when several did), ordered by policy id. */
export function candidatesOn(
  revisions: readonly PolicyRevisionRef[],
  day: string,
): readonly PolicySnapshot[] {
  const best = new Map<string, PolicyRevisionRef>();
  for (const revision of revisions) {
    const current = best.get(revision.policyId);
    if (covers(revision, day) && (!current || revision.revision > current.revision))
      best.set(revision.policyId, revision);
  }
  return [...best.values()].sort((a, b) => a.policyId.localeCompare(b.policyId)).map(snapshotOf);
}

export interface CoverageInput {
  /** `null` while the case has no event time. */
  readonly day: string | null;
  readonly revisions: readonly PolicyRevisionRef[];
  /** `undefined` keeps the policy already linked when it still covers; `null` clears the choice. */
  readonly chosenPolicyId: string | null | undefined;
  readonly previous: PolicySnapshot | null;
}
export interface Coverage {
  readonly status: CoverageStatus;
  readonly snapshot: PolicySnapshot | null;
}

/**
 * BR-I3 / D13: one policy covering the day is linked; several leave the choice to the user; none is
 * reported. A policy that is not the vehicle's is a 404, one that does not cover the day a 422.
 */
export function resolveCoverage(input: CoverageInput): Coverage {
  const { day, revisions, chosenPolicyId } = input;
  if (chosenPolicyId && !revisions.some((revision) => revision.policyId === chosenPolicyId))
    throw new IncidentError('not_found');
  if (day === null) {
    // A policy is chosen for an event day; without one there is nothing to choose it for.
    if (chosenPolicyId)
      throw new IncidentError('invalid_input', [{ field: 'policyId', code: 'conflict' }]);
    return { status: 'unknown', snapshot: null };
  }
  const candidates = candidatesOn(revisions, day);
  const wanted = chosenPolicyId === undefined ? (input.previous?.policyId ?? null) : chosenPolicyId;
  const chosen = candidates.find((candidate) => candidate.policyId === wanted);
  if (chosenPolicyId && !chosen)
    throw new IncidentError('rule_violation', [], RULES.policyNotCovering);
  if (chosen) return { status: 'covered', snapshot: chosen };
  const [only] = candidates;
  if (candidates.length === 1 && only) return { status: 'covered', snapshot: only };
  return { status: candidates.length === 0 ? 'none' : 'multiple', snapshot: null };
}

export interface DriverSuggestion {
  readonly employeeId: string;
  readonly displayName: string;
  readonly type: AssignmentRef['type'];
}

/** BR-I2: assignments in force at the instant (`startedAt <= t`, `endedAt` null or `> t`), principal first. */
export function assignmentsAt(
  assignments: readonly AssignmentRef[],
  instant: string,
): readonly AssignmentRef[] {
  const t = Date.parse(instant);
  return assignments
    .filter(
      (assignment) =>
        Date.parse(assignment.startedAt) <= t &&
        (assignment.endedAt === null || Date.parse(assignment.endedAt) > t),
    )
    .sort(
      (a, b) =>
        ASSIGNMENT_ORDER.indexOf(a.type) - ASSIGNMENT_ORDER.indexOf(b.type) ||
        a.startedAt.localeCompare(b.startedAt) ||
        a.employeeId.localeCompare(b.employeeId),
    );
}

export function driverSuggestions(
  assignments: readonly AssignmentRef[],
  drivers: ReadonlyMap<string, DriverRef>,
): readonly DriverSuggestion[] {
  const seen = new Set<string>();
  const out: DriverSuggestion[] = [];
  for (const assignment of assignments) {
    const driver = drivers.get(assignment.employeeId);
    if (!driver || seen.has(driver.id)) continue;
    seen.add(driver.id);
    out.push({ employeeId: driver.id, displayName: driver.displayName, type: assignment.type });
  }
  return out;
}
