import type { Permission } from '../../identity/src/index.js';

/** The widgets and indicators of the dashboard (BRD §7.1, SPECS §2.3 D5). Ids are stable API names. */
export const WIDGET_IDS = [
  'vehicles_active',
  'vehicles_out_of_service',
  'drivers_active',
  'maintenance_upcoming',
  'documents_expiring',
  'insurance_expiring',
  'incidents_open',
  'incidents_critical',
  'availability',
  'documents_valid_pct',
  'insurance_valid_pct',
  'maintenance_on_time',
  'incidents_monthly',
  'incidents_resolution_time',
  'maintenance_cost',
] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];

export type WidgetKind = 'count' | 'ratio' | 'availability' | 'monthly' | 'duration' | 'money';

/** `today`: the widget reads the state of the company's current day. `range`: it reads the chosen range. */
export type WidgetScope = 'today' | 'range';

/** Where a widget drills down to: the list (or report) that shows exactly the rows it counts. */
export type DrilldownTarget =
  | 'vehicles'
  | 'vehicle_status'
  | 'employees'
  | 'maintenance'
  | 'maintenance_orders'
  | 'documents'
  | 'insurance'
  | 'incidents'
  | 'reports_resolution_time'
  | 'reports_costs';

export interface Drilldown {
  readonly target: DrilldownTarget;
  /** Semantic filters (never URL keys: the web layer maps them to the keys of each list). */
  readonly filters: Readonly<Record<string, string>>;
}

/** What every widget declares: formula, numerator, denominator, scope and the permissions it needs. */
export interface WidgetDefinition {
  readonly id: WidgetId;
  readonly kind: WidgetKind;
  readonly scope: WidgetScope;
  /** Every permission the reader needs; a widget they cannot read is absent from the payload. */
  readonly permissions: readonly Permission[];
  readonly formula: string;
  readonly numerator: string | null;
  readonly denominator: string | null;
}

export interface WidgetBase {
  readonly id: WidgetId;
  readonly kind: WidgetKind;
  readonly scope: WidgetScope;
  readonly definition: Pick<WidgetDefinition, 'formula' | 'numerator' | 'denominator'>;
  readonly drilldown: Drilldown;
}

export interface CountWidget extends WidgetBase {
  readonly kind: 'count';
  readonly value: number;
}

export interface RatioPart {
  readonly subject: 'vehicle' | 'driver';
  readonly numerator: number;
  readonly denominator: number;
}

/** `percent` is null (and the view says "sin datos") when the denominator is 0, never 0 % or 100 %. */
export interface RatioWidget extends WidgetBase {
  readonly kind: 'ratio';
  readonly numerator: number;
  readonly denominator: number;
  readonly percent: number | null;
  readonly parts: readonly RatioPart[];
  /** Cases the formula cannot judge (for example a preventive order with no planned date). */
  readonly excluded: number;
}

export interface DailyAvailability {
  readonly day: string;
  readonly available: number;
  readonly live: number;
}

export interface AvailabilityWidget extends WidgetBase {
  readonly kind: 'availability';
  /** Mean of the daily ratios over the days that have vehicles, in percent with one decimal; null without data. */
  readonly percent: number | null;
  readonly days: number;
  readonly series: readonly DailyAvailability[];
}

export interface MonthlyIncidents {
  readonly month: string;
  readonly reported: number;
  readonly closed: number;
}

export interface MonthlyWidget extends WidgetBase {
  readonly kind: 'monthly';
  readonly months: readonly MonthlyIncidents[];
  readonly reported: number;
  readonly closed: number;
}

export interface DurationWidget extends WidgetBase {
  readonly kind: 'duration';
  /** Cases resolved in the range. */
  readonly count: number;
  /** Days, two decimals; null without cases. */
  readonly medianDays: number | null;
  readonly p90Days: number | null;
}

export interface CurrencyTotal {
  readonly currency: string;
  /** Exact amount in the currency's minor unit, as digits. */
  readonly amountMinor: string;
}

export interface MoneyWidget extends WidgetBase {
  readonly kind: 'money';
  readonly orders: number;
  /** Currencies are never added together (SPECS §5.1). */
  readonly byCurrency: readonly CurrencyTotal[];
}

export type DashboardWidget =
  | CountWidget
  | RatioWidget
  | AvailabilityWidget
  | MonthlyWidget
  | DurationWidget
  | MoneyWidget;

export interface DashboardRange {
  readonly from: string;
  readonly to: string;
}

export interface Dashboard {
  readonly asOf: string;
  readonly timeZone: string;
  readonly today: string;
  readonly range: DashboardRange;
  /** The area filter (descendants included); null for the whole company. */
  readonly areaId: string | null;
  /** The company's expiry window used by the expiring widgets. */
  readonly expiryWindowDays: number;
  readonly widgets: readonly DashboardWidget[];
}

/** A request as the caller writes it; `parseQuery` turns it into a `ResolvedQuery`. */
export interface DashboardQuery {
  readonly areaId?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
}

export interface ResolvedQuery {
  readonly areaId: string | null;
  readonly from: string;
  readonly to: string;
  readonly today: string;
  readonly timeZone: string;
  readonly expiryWindowDays: number;
}

export type AnalyticsErrorCode = 'invalid_input' | 'invalid_area';

export class AnalyticsError extends Error {
  public constructor(
    public readonly code: AnalyticsErrorCode,
    public readonly field?: string,
  ) {
    super(code);
    this.name = 'AnalyticsError';
  }
}
