import type { BffRouteDefinition } from './shared.js';

/** The public events a company can subscribe to (SPECS §7). The domain catalog is checked against this list by the drift test. */
export const BFF_WEBHOOK_EVENTS = [
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
export type BffWebhookEvent = (typeof BFF_WEBHOOK_EVENTS)[number];
/** `ping` is what «Enviar prueba» sends; it is never a subscription. */
export type BffWebhookDeliveredEvent = BffWebhookEvent | 'ping';

export const BFF_WEBHOOK_DELIVERY_STATUSES = [
  'pending',
  'delivered',
  'failed',
  'dead_letter',
] as const;
export type BffWebhookDeliveryStatus = (typeof BFF_WEBHOOK_DELIVERY_STATUSES)[number];

/** An endpoint. It never carries its secret: that is shown once, when it is created or rotated. */
export interface BffWebhookEndpoint {
  readonly id: string;
  readonly url: string;
  readonly events: readonly BffWebhookEvent[];
  readonly active: boolean;
  /** Switched off by the platform after 20 failed attempts in a row. */
  readonly disabled: boolean;
  /** The opaque reference of the company that the receiver sees in `companyRef`. */
  readonly companyRef: string;
  readonly consecutiveFailures: number;
  /** While set, the previous secret still signs next to the new one. */
  readonly previousSecretUntil: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface BffWebhookEndpointList {
  readonly items: readonly BffWebhookEndpoint[];
  /** The company's limit of endpoints. */
  readonly max: number;
}
/** Creation and rotation answer with the secret: the only time it can be read. */
export interface BffWebhookSecret {
  readonly endpoint: BffWebhookEndpoint;
  readonly secret: string;
}
export interface BffWebhookEndpointInput {
  readonly url: string;
  readonly events: readonly BffWebhookEvent[];
  readonly active?: boolean;
}
export interface BffWebhookEndpointPatch {
  readonly version: number;
  readonly url?: string;
  readonly events?: readonly BffWebhookEvent[];
  readonly active?: boolean;
}

/** One delivery. No body and no answer of the receiver: a status code, a duration and an error code. */
export interface BffWebhookDelivery {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: BffWebhookDeliveredEvent;
  readonly status: BffWebhookDeliveryStatus;
  readonly attempts: number;
  readonly lastStatusCode: number | null;
  readonly lastDurationMs: number | null;
  readonly lastError: string | null;
  readonly lastAttemptAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly createdAt: string;
}
export interface BffWebhookDeliveryList {
  readonly items: readonly BffWebhookDelivery[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
}

export interface WebhookRouteTypes {
  'webhooks.list': { response: BffWebhookEndpointList };
  'webhooks.create': { body: BffWebhookEndpointInput; response: BffWebhookSecret };
  'webhooks.get': { params: { endpointId: string }; response: BffWebhookEndpoint };
  'webhooks.update': {
    params: { endpointId: string };
    body: BffWebhookEndpointPatch;
    response: BffWebhookEndpoint;
  };
  'webhooks.delete': { params: { endpointId: string }; response: void };
  'webhooks.rotate': {
    params: { endpointId: string };
    body: { readonly version: number };
    response: BffWebhookSecret;
  };
  'webhooks.test': { params: { endpointId: string }; response: BffWebhookDelivery };
  'webhooks.deliveries': {
    params: { endpointId: string };
    query?: { readonly limit?: number; readonly offset?: number };
    response: BffWebhookDeliveryList;
  };
  'webhooks.retry': {
    params: { endpointId: string; deliveryId: string };
    response: BffWebhookDelivery;
  };
}

const BASE = ['api', 'v1', 'webhooks', 'endpoints'] as const;

export const WEBHOOK_ROUTES = {
  'webhooks.list': { method: 'GET', path: [...BASE], kind: 'session', status: 200 },
  'webhooks.create': { method: 'POST', path: [...BASE], kind: 'session-csrf', status: 201 },
  'webhooks.get': { method: 'GET', path: [...BASE, ':endpointId'], kind: 'session', status: 200 },
  'webhooks.update': {
    method: 'PATCH',
    path: [...BASE, ':endpointId'],
    kind: 'session-csrf',
    status: 200,
  },
  'webhooks.delete': {
    method: 'DELETE',
    path: [...BASE, ':endpointId'],
    kind: 'session-csrf',
    status: 204,
  },
  'webhooks.rotate': {
    method: 'POST',
    path: [...BASE, ':endpointId', 'rotate-secret'],
    kind: 'session-csrf',
    status: 200,
  },
  'webhooks.test': {
    method: 'POST',
    path: [...BASE, ':endpointId', 'test'],
    kind: 'session-csrf',
    status: 200,
  },
  'webhooks.deliveries': {
    method: 'GET',
    path: [...BASE, ':endpointId', 'deliveries'],
    kind: 'session',
    status: 200,
  },
  'webhooks.retry': {
    method: 'POST',
    path: [...BASE, ':endpointId', 'deliveries', ':deliveryId', 'retry'],
    kind: 'session-csrf',
    status: 200,
  },
} as const satisfies Record<keyof WebhookRouteTypes, BffRouteDefinition>;
