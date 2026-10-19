import type { DeliveredEvent, WebhookEvent } from './catalog.js';

export type EndpointDisabledReason = 'failures';

/** An endpoint as stored. The secrets are sealed: nothing here opens them. */
export interface Endpoint {
  readonly id: string;
  readonly tenantId: string;
  readonly url: string;
  readonly events: readonly WebhookEvent[];
  readonly active: boolean;
  readonly disabledReason: EndpointDisabledReason | null;
  /** Opaque identifier of the company for this endpoint: the receiver never sees the internal id. */
  readonly companyRef: string;
  readonly secretSealed: string;
  readonly previousSealed: string | null;
  readonly previousExpiresAt: string | null;
  readonly consecutiveFailures: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
}

export const DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'dead_letter'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface Delivery {
  readonly id: string;
  readonly tenantId: string;
  readonly endpointId: string;
  /** Public id of the event: the same on every attempt and in the header. */
  readonly eventId: string;
  readonly eventType: DeliveredEvent;
  /** The exact bytes that are signed and sent, as text. */
  readonly body: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  /** A manual retry is waiting: one attempt, and no schedule after it. */
  readonly manual: boolean;
  readonly nextAttemptAt: string | null;
  readonly leaseUntil: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastStatusCode: number | null;
  readonly lastDurationMs: number | null;
  /** A code (`http`, `timeout`, `private_address`...): never the receiver's answer. */
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type NewDelivery = Pick<
  Delivery,
  'id' | 'tenantId' | 'endpointId' | 'eventId' | 'eventType' | 'body' | 'createdAt'
>;

export interface DeliveryWork {
  readonly delivery: Delivery;
  readonly endpoint: Endpoint;
}

export type AttemptOutcome =
  | {
      readonly kind: 'delivered';
      readonly statusCode: number;
      readonly durationMs: number;
    }
  | {
      readonly kind: 'retry';
      readonly statusCode: number | null;
      readonly durationMs: number;
      readonly error: string;
      readonly nextAttemptAt: string;
    }
  | {
      readonly kind: 'dead_letter';
      readonly statusCode: number | null;
      readonly durationMs: number;
      readonly error: string;
    };

export interface DriverState {
  readonly tenantId: string;
  readonly driverId: string;
  readonly eligible: boolean;
  /** How many changes were announced: part of the id of the next one. */
  readonly transitions: number;
  readonly updatedAt: string;
}

export interface Window {
  readonly limit: number;
  readonly offset: number;
}
export interface Slice<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/** What the screens get of an endpoint: never a secret, sealed or not. */
export interface EndpointView {
  readonly id: string;
  readonly url: string;
  readonly events: readonly WebhookEvent[];
  readonly active: boolean;
  /** Switched off by the platform after repeated failures. */
  readonly disabled: boolean;
  readonly companyRef: string;
  readonly consecutiveFailures: number;
  /** Until when the previous secret still signs, after a rotation. */
  readonly previousSecretUntil: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeliveryView {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: DeliveredEvent;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly lastStatusCode: number | null;
  readonly lastDurationMs: number | null;
  readonly lastError: string | null;
  readonly lastAttemptAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly createdAt: string;
}

/** A public event ready to fan out: ids, folios and states only. */
export interface PublicEvent {
  /** Public, opaque and stable for the fact it announces. */
  readonly eventId: string;
  readonly type: DeliveredEvent;
  readonly occurredAt: string;
  readonly data: Readonly<Record<string, string | number | boolean | null | readonly string[]>>;
}
