/** The public events of SPECS §7. `document.*` and `policy.*` (BRD §18.4) are not adopted. */
export const WEBHOOK_EVENTS = [
  'vehicle.created',
  'vehicle.updated',
  'vehicle.status_changed',
  'driver.created',
  'driver.updated',
  'driver.eligibility_changed',
  'incident.created',
  'incident.status_changed',
  'incident.closed',
  'maintenance.created',
  'maintenance.status_changed',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
/** Sent by «Enviar prueba»; it is never part of a subscription. */
export const PING_EVENT = 'ping';
export type DeliveredEvent = WebhookEvent | typeof PING_EVENT;
export const isWebhookEvent = (value: unknown): value is WebhookEvent =>
  typeof value === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(value);

export const SCHEMA_VERSION = 1;

/** ADR-0016, question 4. */
export const MAX_ENDPOINTS = 5;
export const DELIVERIES_PER_MINUTE = 60;
/** The initial attempt and five retries at 1m, 5m, 30m, 2h and 12h. */
export const RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3_600_000,
  12 * 3_600_000,
] as const;
export const MAX_AUTOMATIC_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
export const JITTER = 0.2;
/** Consecutive failed attempts after which an endpoint is switched off. */
export const DISABLE_AFTER_FAILURES = 20;
/** A rotated secret keeps signing next to the new one for this long. */
export const SECRET_GRACE_MS = 24 * 3_600_000;
export const RETENTION_MS = 30 * 24 * 3_600_000;
/** Far above one attempt (10 s) plus the tick budget, so a lease never lapses under its own worker. */
export const LEASE_MS = 2 * 60_000;
/** Wall-clock time one company may spend in one tick before the rest of its batch waits. */
export const TICK_BUDGET_MS = 30_000;
export const BATCH = 60;
export const MAX_BODY_BYTES = 8 * 1024;
export const SECRET_ENTITY = 'webhook_endpoint';
