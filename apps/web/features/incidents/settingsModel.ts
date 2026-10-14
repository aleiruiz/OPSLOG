import type {
  BffAlertSettings,
  BffAlertSettingsInput,
  BffIncidentReportPhoto,
  BffIncidentSeverity,
} from '@opslog/contracts';
import { amountText, parseAmount } from './money';

/** The incident settings as fields of text; the server owns the defaults (7/15/30/45 days, 5 days without movement). */
export interface SettingsValues {
  readonly photo: BffIncidentReportPhoto;
  readonly days: Readonly<Record<BffIncidentSeverity, string>>;
  readonly inactivity: string;
  readonly thresholdAmount: string;
  readonly thresholdCurrency: string;
}
export type SettingsField =
  | 'days.critical'
  | 'days.high'
  | 'days.medium'
  | 'days.low'
  | 'inactivity'
  | 'threshold'
  | 'currency';
export type SettingsProblems = Partial<Record<SettingsField, string>>;

export const SEVERITY_ORDER: readonly BffIncidentSeverity[] = ['critical', 'high', 'medium', 'low'];
export const MAX_SLA_DAYS = 365;
export const MAX_INACTIVITY_DAYS = 60;

export function valuesOf(settings: BffAlertSettings): SettingsValues {
  const days = settings.incidentSlaDays ?? { critical: 7, high: 15, medium: 30, low: 45 };
  const threshold = settings.closeCostThreshold;
  return {
    photo: settings.incidentReportPhoto ?? 'photo_or_justification',
    days: {
      critical: String(days.critical),
      high: String(days.high),
      medium: String(days.medium),
      low: String(days.low),
    },
    inactivity: String(settings.incidentInactivityDays ?? 5),
    thresholdAmount: threshold ? amountText(threshold.amountMinor, threshold.currency) : '',
    thresholdCurrency: threshold?.currency ?? 'MXN',
  };
}

const whole = (text: string, max: number): boolean =>
  /^\d{1,3}$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= max;

export function validate(values: SettingsValues): SettingsProblems {
  const problems: SettingsProblems = {};
  for (const severity of SEVERITY_ORDER)
    if (!whole(values.days[severity], MAX_SLA_DAYS))
      problems[`days.${severity}`] = `Escribe un número entero de días entre 1 y ${MAX_SLA_DAYS}.`;
  if (!whole(values.inactivity, MAX_INACTIVITY_DAYS))
    problems.inactivity = `Escribe un número entero de días entre 1 y ${MAX_INACTIVITY_DAYS}.`;
  if (values.thresholdAmount.trim() !== '') {
    if (!/^[A-Z]{3}$/.test(values.thresholdCurrency))
      problems.currency = 'Usa un código de moneda de tres letras, por ejemplo MXN.';
    else if (parseAmount(values.thresholdAmount, values.thresholdCurrency) === null)
      problems.threshold = 'Escribe un monto mayor a cero, con los decimales que admite la moneda.';
  }
  return problems;
}

/** The full write, keeping the expiry window and the recipients the alert settings screen owns. */
export function toInput(settings: BffAlertSettings, values: SettingsValues): BffAlertSettingsInput {
  const amount =
    values.thresholdAmount.trim() === ''
      ? null
      : parseAmount(values.thresholdAmount, values.thresholdCurrency);
  return {
    version: settings.version,
    expiryWindowDays: settings.expiryWindowDays,
    recipientRoles: settings.recipientRoles,
    incidentReportPhoto: values.photo,
    incidentSlaDays: {
      critical: Number(values.days.critical),
      high: Number(values.days.high),
      medium: Number(values.days.medium),
      low: Number(values.days.low),
    },
    incidentInactivityDays: Number(values.inactivity),
    // Absent without `incidents:view_costs`: the stored threshold stays as it is.
    ...(settings.closeCostThreshold === undefined
      ? {}
      : {
          closeCostThreshold:
            amount === null ? null : { amountMinor: amount, currency: values.thresholdCurrency },
        }),
  };
}

/** What the person changed and has not saved: kept apart from the saved settings so a reload never discards it. */
export interface SettingsEdits {
  readonly photo?: BffIncidentReportPhoto;
  readonly days?: Partial<Record<BffIncidentSeverity, string>>;
  readonly inactivity?: string;
  readonly thresholdAmount?: string;
  readonly thresholdCurrency?: string;
}
export const applyEdits = (base: SettingsValues, edits: SettingsEdits): SettingsValues => ({
  photo: edits.photo ?? base.photo,
  days: { ...base.days, ...edits.days },
  inactivity: edits.inactivity ?? base.inactivity,
  thresholdAmount: edits.thresholdAmount ?? base.thresholdAmount,
  thresholdCurrency: edits.thresholdCurrency ?? base.thresholdCurrency,
});
