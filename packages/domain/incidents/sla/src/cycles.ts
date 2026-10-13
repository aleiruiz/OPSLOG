import type { Incident, IncidentTransition } from '../../cases/src/index.js';
import type { SlaSettings } from './catalog.js';
import type { CycleFacts, CycleRow } from './types.js';

export type HistoryLoader = () => Promise<readonly IncidentTransition[]>;

/** The `index`-th (1-based) timeline entry of a command; one `resolve` and one `reopen` per cycle. */
const nthEntry = (history: readonly IncidentTransition[], command: string, index: number) =>
  history.filter((entry) => entry.command === command)[index - 1]?.occurredAt ?? null;

/**
 * When a cycle began: the report for the first one, the `reopen` that opened it for the rest
 * (SPECS §6.2: a reopened cycle is measured apart and the first SLA is never recalculated).
 */
async function startOf(
  incident: Incident,
  cycle: number,
  history: HistoryLoader,
): Promise<string | null> {
  return cycle === 1 ? incident.reportedAt : nthEntry(await history(), 'reopen', cycle - 1);
}

/** When a cycle ended. `resolvedAt` of the case belongs to the current cycle only once it is after the start. */
async function endOf(
  incident: Incident,
  cycle: number,
  startedAt: string,
  history: HistoryLoader,
): Promise<string | null> {
  if (cycle < incident.cycle) return nthEntry(await history(), 'resolve', cycle);
  return incident.resolvedAt !== null && Date.parse(incident.resolvedAt) >= Date.parse(startedAt)
    ? incident.resolvedAt
    : null;
}

/**
 * A cycle as it stands now. A stored cycle keeps the target it was given; a severity that changed
 * since asks for a new target from the settings of today (`retarget`). A cycle the scan has not seen
 * yet is derived from the case and the current settings (`open`). `null`: the cycle never started.
 */
export async function cycleFacts(
  incident: Incident,
  cycle: number,
  rows: readonly CycleRow[],
  settings: SlaSettings,
  history: HistoryLoader,
): Promise<CycleFacts | null> {
  const stored = rows.find((row) => row.cycle === cycle);
  const startedAt = stored?.startedAt ?? (await startOf(incident, cycle, history));
  if (startedAt === null) return null;
  const resolvedAt = await endOf(incident, cycle, startedAt, history);
  // A cycle that already ended keeps the severity it ended with: only the current one is retargeted.
  const retarget =
    stored !== undefined && cycle === incident.cycle && stored.severity !== incident.severity;
  const severity = stored && !retarget ? stored.severity : incident.severity;
  if (severity === null) return null;
  if (stored && !retarget)
    return {
      cycle,
      startedAt,
      severity,
      targetDays: stored.targetDays,
      targetVersion: stored.targetVersion,
      resolvedAt,
      pending: null,
    };
  return {
    cycle,
    startedAt,
    severity,
    targetDays: settings.targetDays[severity],
    targetVersion: (stored?.targetVersion ?? 0) + 1,
    resolvedAt,
    pending: retarget ? 'retarget' : 'open',
  };
}
