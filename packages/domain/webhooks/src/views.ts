import type { Delivery, DeliveryView, Endpoint, EndpointView } from './types.js';

export const endpointView = (endpoint: Endpoint, now: Date): EndpointView => ({
  id: endpoint.id,
  url: endpoint.url,
  events: endpoint.events,
  active: endpoint.active,
  disabled: endpoint.disabledReason !== null,
  companyRef: endpoint.companyRef,
  consecutiveFailures: endpoint.consecutiveFailures,
  previousSecretUntil:
    endpoint.previousExpiresAt !== null && Date.parse(endpoint.previousExpiresAt) > now.getTime()
      ? endpoint.previousExpiresAt
      : null,
  version: endpoint.version,
  createdAt: endpoint.createdAt,
  updatedAt: endpoint.updatedAt,
});

/** No body, no lease: what the history shows of an attempt. */
export const deliveryView = (delivery: Delivery): DeliveryView => ({
  id: delivery.id,
  eventId: delivery.eventId,
  eventType: delivery.eventType,
  status: delivery.status,
  attempts: delivery.attempts,
  lastStatusCode: delivery.lastStatusCode,
  lastDurationMs: delivery.lastDurationMs,
  lastError: delivery.lastError,
  lastAttemptAt: delivery.lastAttemptAt,
  nextAttemptAt: delivery.nextAttemptAt,
  createdAt: delivery.createdAt,
});
