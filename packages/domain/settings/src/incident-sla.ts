/**
 * Incident SLA settings (INC-SLA, SPECS §2.3 D17): the target in calendar days per severity and the
 * days without movement after which a case is flagged. A company that never saved reads the defaults.
 * The parsers answer `null` for a bad value; the service turns that into `invalid_input`.
 */
export const INCIDENT_SLA_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type IncidentSlaSeverity = (typeof INCIDENT_SLA_SEVERITIES)[number];
export type IncidentSlaDays = Readonly<Record<IncidentSlaSeverity, number>>;

/** D17: Crítica 7, Alta 15, Media 30, Baja 45 días calendario. */
export const DEFAULT_INCIDENT_SLA_DAYS: IncidentSlaDays = {
  critical: 7,
  high: 15,
  medium: 30,
  low: 45,
};
export const MIN_INCIDENT_SLA_DAYS = 1;
export const MAX_INCIDENT_SLA_DAYS = 365;
/** BRD §11.3: N = 5 days without an update, escalated at 2N. */
export const DEFAULT_INCIDENT_INACTIVITY_DAYS = 5;
export const MIN_INCIDENT_INACTIVITY_DAYS = 1;
export const MAX_INCIDENT_INACTIVITY_DAYS = 60;

const whole = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/** Exactly the four severities, each a whole number of days in range; no partial object. */
export function parseIncidentSlaDays(value: unknown): IncidentSlaDays | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const fields = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(fields);
  if (
    keys.length !== INCIDENT_SLA_SEVERITIES.length ||
    INCIDENT_SLA_SEVERITIES.some((severity) => !keys.includes(severity))
  )
    return null;
  const days = INCIDENT_SLA_SEVERITIES.map((severity) => fields[severity]);
  if (!days.every((day) => whole(day, MIN_INCIDENT_SLA_DAYS, MAX_INCIDENT_SLA_DAYS))) return null;
  const [critical, high, medium, low] = days as [number, number, number, number];
  return { critical, high, medium, low };
}

export function parseIncidentInactivityDays(value: unknown): number | null {
  return whole(value, MIN_INCIDENT_INACTIVITY_DAYS, MAX_INCIDENT_INACTIVITY_DAYS) ? value : null;
}
