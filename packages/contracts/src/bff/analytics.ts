import type { BffRouteDefinition } from './shared.js';

/** Stable ids of the dashboard indicators (BRD §7.1). A reader without permission never receives one. */
export const BFF_WIDGET_IDS = [
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
export type BffWidgetId = (typeof BFF_WIDGET_IDS)[number];

/** `today`: the state of the company's current day. `range`: the range the reader chose. */
export type BffWidgetScope = 'today' | 'range';

/** The list or report a widget drills down to, with the semantic filters that reproduce its rows. */
export interface BffWidgetDrilldown {
  readonly target: string;
  readonly filters: Readonly<Record<string, string>>;
}

/** Formula, numerator and denominator in words, so the figure is never ambiguous. */
export interface BffWidgetDefinition {
  readonly formula: string;
  readonly numerator: string | null;
  readonly denominator: string | null;
}

interface BffWidgetBase {
  readonly id: BffWidgetId;
  readonly scope: BffWidgetScope;
  readonly definition: BffWidgetDefinition;
  readonly drilldown: BffWidgetDrilldown;
}

export interface BffCountWidget extends BffWidgetBase {
  readonly kind: 'count';
  readonly value: number;
}

export interface BffRatioPart {
  readonly subject: 'vehicle' | 'driver';
  readonly numerator: number;
  readonly denominator: number;
}

/** `percent` is null ("sin datos") when the denominator is 0. */
export interface BffRatioWidget extends BffWidgetBase {
  readonly kind: 'ratio';
  readonly numerator: number;
  readonly denominator: number;
  readonly percent: number | null;
  readonly parts: readonly BffRatioPart[];
  /** Cases the formula cannot judge, left out of both terms. */
  readonly excluded: number;
}

export interface BffDailyAvailability {
  readonly day: string;
  readonly available: number;
  readonly live: number;
}

export interface BffAvailabilityWidget extends BffWidgetBase {
  readonly kind: 'availability';
  readonly percent: number | null;
  readonly days: number;
  readonly series: readonly BffDailyAvailability[];
}

export interface BffMonthlyIncidents {
  /** `YYYY-MM` in the company's zone. */
  readonly month: string;
  readonly reported: number;
  readonly closed: number;
}

export interface BffMonthlyWidget extends BffWidgetBase {
  readonly kind: 'monthly';
  readonly months: readonly BffMonthlyIncidents[];
  readonly reported: number;
  readonly closed: number;
}

export interface BffDurationWidget extends BffWidgetBase {
  readonly kind: 'duration';
  readonly count: number;
  readonly medianDays: number | null;
  readonly p90Days: number | null;
}

export interface BffCurrencyTotal {
  readonly currency: string;
  /** Exact amount in the currency's minor unit, as digits. */
  readonly amountMinor: string;
}

export interface BffMoneyWidget extends BffWidgetBase {
  readonly kind: 'money';
  readonly orders: number;
  /** Currencies are never added together. */
  readonly byCurrency: readonly BffCurrencyTotal[];
}

export type BffDashboardWidget =
  | BffCountWidget
  | BffRatioWidget
  | BffAvailabilityWidget
  | BffMonthlyWidget
  | BffDurationWidget
  | BffMoneyWidget;

/**
 * The dashboard of Inicio. `widgets` holds only the indicators the reader may see; the others are
 * absent, with no count and no name. `asOf` is when the figures were computed (they may be up to
 * five minutes old). Days are days of the company's `timeZone`.
 */
export interface BffDashboard {
  readonly asOf: string;
  readonly timeZone: string;
  readonly today: string;
  readonly range: { readonly from: string; readonly to: string };
  readonly areaId: string | null;
  readonly expiryWindowDays: number;
  readonly widgets: readonly BffDashboardWidget[];
}

/** Area filter (its descendants count too) and range of company days; defaults: the last 30 days. */
export interface BffDashboardQuery {
  readonly areaId?: string;
  readonly from?: string;
  readonly to?: string;
}

/** Request and response types of the analytics routes. */
export interface AnalyticsRouteTypes {
  'dashboard.get': { query?: BffDashboardQuery; response: BffDashboard };
}

export const ANALYTICS_ROUTES = {
  'dashboard.get': {
    method: 'GET',
    path: ['api', 'v1', 'dashboard'],
    kind: 'session',
    status: 200,
  },
} as const satisfies Record<keyof AnalyticsRouteTypes, BffRouteDefinition>;
