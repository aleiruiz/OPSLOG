import type { Incident, IncidentStore } from '../../cases/src/index.js';
import { isWatched, WATCHED_STATUSES, type SlaSettings } from './catalog.js';
import { cycleFacts } from './cycles.js';
import { dueAlerts } from './evaluate.js';
import type { IncidentSlaStore, SlaSettingsReader } from './ports.js';
import type { CycleFacts, CycleRow, NewAlert } from './types.js';

const PAGE = 100;
export const alertKey = (
  incidentId: string,
  cycle: number,
  kind: string,
  dedupeRef: string,
): string => `${incidentId}|${cycle}|${kind}|${dedupeRef}`;

export interface ScanSummary {
  readonly examined: number;
  readonly created: number;
}
export interface IncidentSlaScannerOptions {
  readonly now?: () => Date;
}

/**
 * The SLA scan (SPECS §4.3, §7, §9.3). It reads the case, its cycle and the company settings when it
 * runs, never from the job, and writes each due notice once: the unique key of the store settles a
 * rerun or a second worker. The tenant is an argument taken from the claimed job.
 */
export class IncidentSlaScanner {
  private readonly now: () => Date;
  public constructor(
    private readonly incidents: IncidentStore,
    private readonly store: IncidentSlaStore,
    private readonly settings: SlaSettingsReader,
    options: IncidentSlaScannerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** One case, or every watched case of the tenant in pages of 100 (never all in memory at once). */
  public async scan(tenantId: string, incidentId?: string): Promise<ScanSummary> {
    const settings = await this.settings.settings(tenantId);
    const nowMs = this.now().getTime();
    let examined = 0;
    let created = 0;
    const page = async (cases: readonly Incident[]) => {
      const watched = cases.filter((incident) => isWatched(incident.status));
      const ids = watched.map((incident) => incident.id);
      if (ids.length === 0) return;
      const rows = await this.store.cycles(tenantId, ids);
      const keys = await this.store.alertKeys(tenantId, ids);
      for (const incident of watched) {
        examined += 1;
        created += await this.scanOne(
          incident,
          rows.filter((row) => row.incidentId === incident.id),
          keys,
          settings,
          nowMs,
        );
      }
    };
    if (incidentId !== undefined) {
      const incident = await this.incidents.get(tenantId, incidentId);
      if (incident) await page([incident]);
      return { examined, created };
    }
    const query = {
      filter: { statuses: WATCHED_STATUSES },
      sort: 'createdAt',
      direction: 'asc',
      limit: PAGE,
    } as const;
    for (let offset = 0; ; offset += PAGE) {
      const slice = await this.incidents.list(tenantId, { ...query, offset });
      await page(slice.items);
      if (offset + PAGE >= slice.total || slice.items.length === 0) return { examined, created };
    }
  }

  private async scanOne(
    incident: Incident,
    stored: readonly CycleRow[],
    keys: ReadonlySet<string>,
    settings: SlaSettings,
    nowMs: number,
  ): Promise<number> {
    const history = () => this.incidents.history(incident.tenantId, incident.id);
    let rows = stored;
    let facts = await cycleFacts(incident, incident.cycle, rows, settings, history);
    if (facts?.pending) {
      const row: CycleRow = {
        tenantId: incident.tenantId,
        incidentId: incident.id,
        cycle: facts.cycle,
        startedAt: facts.startedAt,
        severity: facts.severity,
        targetDays: facts.targetDays,
        targetVersion: facts.targetVersion,
      };
      if (facts.pending === 'open') await this.store.openCycle(row);
      else if (!(await this.store.retarget(row, facts.targetVersion - 1))) {
        // Another worker moved the target first: judge the case on what it wrote.
        rows = await this.store.cycles(incident.tenantId, [incident.id]);
        facts = await cycleFacts(incident, incident.cycle, rows, settings, history);
      }
    }
    return this.write(incident, facts, keys, settings, nowMs);
  }

  private async write(
    incident: Incident,
    facts: CycleFacts | null,
    keys: ReadonlySet<string>,
    settings: SlaSettings,
    nowMs: number,
  ): Promise<number> {
    let created = 0;
    for (const due of dueAlerts(incident, facts, settings, nowMs)) {
      if (keys.has(alertKey(incident.id, due.cycle, due.kind, due.dedupeRef))) continue;
      const made = await this.store.createAlert(this.newAlert(incident, due, nowMs));
      if (made) created += 1;
    }
    return created;
  }

  private newAlert(
    incident: Incident,
    due: { kind: NewAlert['kind']; cycle: number; dedupeRef: string; deadline: string | null },
    nowMs: number,
  ): NewAlert {
    return {
      tenantId: incident.tenantId,
      incidentId: incident.id,
      folio: incident.folio,
      cycle: due.cycle,
      kind: due.kind,
      dedupeRef: due.dedupeRef,
      severity: incident.severity,
      deadline: due.deadline,
      subjectId: null,
      createdAt: new Date(nowMs).toISOString(),
    };
  }

  /**
   * `incident.assigned`: the notice to the new responsible, once per case version. A case that is
   * terminal, still a draft, gone or without a responsible gets none.
   */
  public async onAssigned(
    tenantId: string,
    event: { readonly incidentId: string; readonly version: number },
  ): Promise<boolean> {
    const incident = await this.incidents.get(tenantId, event.incidentId);
    if (!incident || !isWatched(incident.status) || incident.responsibleId === null) return false;
    const made = await this.store.createAlert({
      ...this.newAlert(
        incident,
        { kind: 'assigned', cycle: incident.cycle, dedupeRef: `v${event.version}`, deadline: null },
        this.now().getTime(),
      ),
      subjectId: incident.responsibleId,
    });
    return made !== null;
  }
}
