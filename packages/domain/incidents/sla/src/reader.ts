import {
  IncidentError,
  canView,
  can,
  isMechanicScoped,
  type Incident,
  type IncidentActor,
  type IncidentStore,
} from '../../cases/src/index.js';
import { cycleFacts, type HistoryLoader } from './cycles.js';
import { evaluate } from './evaluate.js';
import { parseAlertQuery } from './query.js';
import type { IncidentSlaStore, SlaSettingsReader } from './ports.js';
import type { AlertItem, AlertPage, CycleRow, IncidentSlaView, SlaPreviousCycle } from './types.js';
import type { SlaSettings } from './catalog.js';

export interface IncidentSlaReaderOptions {
  readonly now?: () => Date;
}

/**
 * What the screens read of the SLA: the calculated block of each case and the notices the caller may
 * see. Nothing here writes; the SLA of a case is computed on every read from the case and its cycles.
 */
export class IncidentSlaReader {
  private readonly now: () => Date;
  public constructor(
    private readonly incidents: IncidentStore,
    private readonly store: IncidentSlaStore,
    private readonly settings: SlaSettingsReader,
    options: IncidentSlaReaderOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /** The `sla` block of each case that has one, by case id. A cancelled case that never resolved has none. */
  public async forIncidents(
    tenantId: string,
    cases: readonly Incident[],
  ): Promise<ReadonlyMap<string, IncidentSlaView>> {
    const views = new Map<string, IncidentSlaView>();
    if (cases.length === 0) return views;
    const settings = await this.settings.settings(tenantId);
    const rows = await this.store.cycles(
      tenantId,
      cases.map((incident) => incident.id),
    );
    const nowMs = this.now().getTime();
    for (const incident of cases) {
      const view = await this.viewOf(
        incident,
        rows.filter((row) => row.incidentId === incident.id),
        settings,
        nowMs,
      );
      if (view) views.set(incident.id, view);
    }
    return views;
  }

  private async viewOf(
    incident: Incident,
    rows: readonly CycleRow[],
    settings: SlaSettings,
    nowMs: number,
  ): Promise<IncidentSlaView | null> {
    let loaded: ReturnType<HistoryLoader> | null = null;
    // The timeline is only read for a reopened case, once.
    const history: HistoryLoader = () =>
      (loaded ??= this.incidents.history(incident.tenantId, incident.id));
    const current = await cycleFacts(incident, incident.cycle, rows, settings, history);
    if (!current)
      return incident.status === 'cancelled'
        ? null
        : {
            cycle: incident.cycle,
            state: 'not_started',
            startedAt: null,
            deadline: null,
            targetDays: null,
            elapsedPercent: 0,
            resolvedAt: null,
            previousCycles: [],
          };
    if (current.resolvedAt === null && incident.status === 'cancelled') return null;
    const { deadline, state, elapsedPercent } = evaluate(current, settings.timeZone, nowMs);
    const previousCycles: SlaPreviousCycle[] = [];
    for (let cycle = 1; cycle < incident.cycle; cycle += 1) {
      const facts = await cycleFacts(incident, cycle, rows, settings, history);
      if (!facts) continue;
      const ended = facts.resolvedAt === null ? null : Date.parse(facts.resolvedAt);
      const target = Date.parse(evaluate(facts, settings.timeZone, nowMs).deadline);
      previousCycles.push({
        cycle,
        startedAt: facts.startedAt,
        resolvedAt: facts.resolvedAt,
        met: ended !== null && ended <= target,
      });
    }
    return {
      cycle: current.cycle,
      state,
      startedAt: current.startedAt,
      deadline,
      targetDays: current.targetDays,
      elapsedPercent,
      resolvedAt: current.resolvedAt,
      previousCycles,
    };
  }

  /**
   * The notices the member may see, newest first (`GET /incidents/alerts`). A member who cannot read
   * incidents gets a refusal; a mechanic-scoped one gets an empty page, like the case list.
   */
  public async alerts(tenantId: string, actor: IncidentActor, input: unknown): Promise<AlertPage> {
    if (!can(actor, 'incidents:view')) throw new IncidentError('forbidden');
    const query = parseAlertQuery(input);
    if (isMechanicScoped(actor) || !canView(actor)) return { items: [], total: 0 };
    const slice = await this.store.listAlerts(
      tenantId,
      {
        id: actor.id,
        edit: can(actor, 'incidents:edit'),
        approve: can(actor, 'incidents:approve'),
      },
      {
        ...(query.kind === undefined ? {} : { kind: query.kind }),
        ...(query.incidentId === undefined ? {} : { incidentId: query.incidentId }),
      },
      { limit: query.limit, offset: query.offset },
    );
    return {
      items: slice.rows.map(
        (row): AlertItem => ({
          id: row.id,
          incidentId: row.incidentId,
          folio: row.folio,
          kind: row.kind,
          cycle: row.cycle,
          createdAt: row.createdAt,
          severity: row.severity,
          deadline: row.deadline,
        }),
      ),
      total: slice.total,
    };
  }
}
