import type {
  BffDashboard,
  BffDashboardQuery,
  BffDashboardWidget,
  BffWidgetId,
} from '@opslog/contracts';
import type { Permission, Result } from '../../app/types';
import { addDays } from '../audit/range';
import type { DashboardPort } from './ports';

const OPEN =
  'reported,under_review,insurance_process,insurance_rejected,no_insurance,repair,resolved,reopened';
const TODAY = '2026-10-06';
const ZONE = 'America/Mexico_City';
const EXPIRY_DAYS = 30;

/** Who may see what, as the server decides it: every permission of a widget must be held. */
const NEEDS: Readonly<Record<BffWidgetId, readonly Permission[]>> = {
  vehicles_active: ['view'],
  vehicles_out_of_service: ['view'],
  drivers_active: ['view'],
  maintenance_upcoming: ['view'],
  documents_expiring: ['view'],
  insurance_expiring: ['view'],
  incidents_open: ['incidents:view'],
  incidents_critical: ['incidents:view'],
  availability: ['view'],
  documents_valid_pct: ['view'],
  insurance_valid_pct: ['view'],
  maintenance_on_time: ['view'],
  incidents_monthly: ['incidents:view'],
  incidents_resolution_time: ['incidents:view'],
  maintenance_cost: ['view', 'view_costs'],
};

const def = (formula: string) => ({ formula, numerator: null, denominator: null });
const ratio = (numerator: number, denominator: number) =>
  denominator === 0 ? null : Math.round((1000 * numerator) / denominator) / 10;

/** Every widget for a scope; `share` shrinks the figures when an area narrows the company. */
function allWidgets(
  share: number,
  q: { areaId: string | null; from: string; to: string },
  empty: boolean,
): BffDashboardWidget[] {
  const n = (value: number) => (empty ? 0 : Math.round(value * share));
  const area = q.areaId ? { areaId: q.areaId } : {};
  const range = { from: q.from, to: q.to };
  const count = (id: BffWidgetId, value: number, filters: Record<string, string>) =>
    ({
      id,
      kind: 'count',
      scope: 'today',
      definition: def(id),
      drilldown: { target: 'vehicles', filters: { ...filters, ...area } },
      value: n(value),
    }) as const;
  const pct = (id: BffWidgetId, num: number, den: number, filters: Record<string, string>) =>
    ({
      id,
      kind: 'ratio',
      scope: id === 'maintenance_on_time' ? 'range' : 'today',
      definition: def(id),
      drilldown: { target: 'vehicles', filters: { ...filters, ...area } },
      numerator: n(num),
      denominator: n(den),
      percent: ratio(n(num), n(den)),
      parts: [],
      excluded: 0,
    }) as const;
  const days: { day: string; available: number; live: number }[] = [];
  for (let day = q.from; day <= q.to && days.length < 366; day = addDays(day, 1))
    days.push({ day, available: n(40 - (days.length % 5)), live: n(48) });
  const live = days.reduce((sum, d) => sum + d.live, 0);
  const availableTotal = days.reduce((sum, d) => sum + d.available, 0);
  return [
    count('vehicles_active', 40, { status: 'active' }),
    count('vehicles_out_of_service', 8, { status: 'out_of_service,in_maintenance' }),
    count('drivers_active', 31, { kind: 'driver', status: 'active' }),
    count('maintenance_upcoming', 6, { view: 'upcoming' }),
    count('documents_expiring', 9, { expiry: 'expiring', withinDays: String(EXPIRY_DAYS) }),
    count('insurance_expiring', 3, { expiry: 'expiring', withinDays: String(EXPIRY_DAYS) }),
    count('incidents_open', 5, { statuses: OPEN }),
    count('incidents_critical', 2, { statuses: OPEN, critical: 'true' }),
    {
      id: 'availability',
      kind: 'availability',
      scope: 'range',
      definition: def('availability'),
      drilldown: { target: 'vehicle_status', filters: { ...range, ...area } },
      percent: ratio(availableTotal, live),
      days: days.length,
      series: days,
    },
    pct('documents_valid_pct', 52, 60, { expiry: 'expired' }),
    pct('insurance_valid_pct', 36, 40, { status: 'active', insurance: 'none' }),
    pct('maintenance_on_time', 14, 18, { kind: 'preventive', status: 'closed', onTime: 'false' }),
    {
      id: 'incidents_monthly',
      kind: 'monthly',
      scope: 'range',
      definition: def('incidents_monthly'),
      drilldown: {
        target: 'incidents',
        filters: { reportedFrom: q.from, reportedTo: q.to, ...area },
      },
      months: empty
        ? []
        : [
            { month: '2026-08', reported: n(4), closed: n(3) },
            { month: '2026-09', reported: n(6), closed: n(5) },
            { month: '2026-10', reported: n(2), closed: n(3) },
          ],
      reported: n(12),
      closed: n(11),
    },
    {
      id: 'incidents_resolution_time',
      kind: 'duration',
      scope: 'range',
      definition: def('incidents_resolution_time'),
      drilldown: { target: 'reports_resolution_time', filters: { ...range, ...area } },
      count: n(11),
      medianDays: empty ? null : 4.5,
      p90Days: empty ? null : 12,
    },
    {
      id: 'maintenance_cost',
      kind: 'money',
      scope: 'range',
      definition: def('maintenance_cost'),
      drilldown: { target: 'reports_costs', filters: { ...range, ...area } },
      orders: n(14),
      byCurrency: empty ? [] : [{ currency: 'MXN', amountMinor: String(n(18_450_000)) }],
    },
  ];
}

export interface FakeDashboard extends DashboardPort {
  /** Every query received, to assert what the screen asked for. */
  readonly calls: BffDashboardQuery[];
}

/**
 * In-memory dashboard with the contract of `GET /api/v1/dashboard`: a widget the reader lacks permission for is
 * absent (no key, no count). `empty` models a company without data (every denominator is 0).
 * All data is synthetic.
 */
export function createFakeDashboard(options: {
  can: (permission: Permission) => boolean;
  empty?: boolean;
}): FakeDashboard {
  const calls: BffDashboardQuery[] = [];
  return {
    calls,
    get: (query = {}): Promise<Result<BffDashboard>> => {
      calls.push(query);
      const to = query.to ?? TODAY;
      const from = query.from ?? addDays(to, -29);
      if (from > to)
        return Promise.resolve({
          ok: false,
          error: {
            status: 422,
            code: 'invalid_input',
            message: 'Invalid range',
            correlationId: 'mock',
          },
        });
      const areaId = query.areaId ?? null;
      const widgets = allWidgets(
        areaId ? 0.5 : 1,
        { areaId, from, to },
        options.empty === true,
      ).filter((widget) => NEEDS[widget.id].every(options.can));
      return Promise.resolve({
        ok: true,
        value: {
          asOf: '2026-10-06T12:00:00.000Z',
          timeZone: ZONE,
          today: TODAY,
          range: { from, to },
          areaId,
          expiryWindowDays: EXPIRY_DAYS,
          widgets,
        },
      });
    },
  };
}
