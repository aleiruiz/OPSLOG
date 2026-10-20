import type {
  AttemptOutcome,
  Delivery,
  DeliveryWork,
  DriverState,
  Endpoint,
  NewDelivery,
  Slice,
  Window,
} from './types.js';

/**
 * Persistence of endpoints and deliveries. Every method names the company: a row of another
 * company is simply absent.
 */
export interface WebhookStore {
  /** `false` when the company already has `max` endpoints (checked and inserted atomically). */
  createEndpoint(endpoint: Endpoint, max: number): Promise<boolean>;
  endpoints(tenantId: string): Promise<readonly Endpoint[]>;
  endpoint(tenantId: string, id: string): Promise<Endpoint | null>;
  /** Compare and set on `version`: writes `next` only while the stored version is `expectedVersion`. */
  saveEndpoint(next: Endpoint, expectedVersion: number): Promise<boolean>;
  /** Removes the endpoint and its deliveries. */
  deleteEndpoint(tenantId: string, id: string): Promise<boolean>;

  /** One per endpoint and event id: a repeated event creates nothing. Returns how many are new. */
  addDeliveries(deliveries: readonly NewDelivery[]): Promise<number>;
  deliveries(tenantId: string, endpointId: string, window: Window): Promise<Slice<Delivery>>;
  delivery(tenantId: string, endpointId: string, id: string): Promise<Delivery | null>;
  /** From `dead_letter` or `failed` to a pending attempt that is due now; null when it is not retryable. */
  retryNow(tenantId: string, endpointId: string, id: string, at: string): Promise<Delivery | null>;

  /** Due deliveries of active endpoints, taken for `leaseMs` so two workers never send the same one. */
  claimDue(
    tenantId: string,
    now: Date,
    leaseMs: number,
    limit: number,
  ): Promise<readonly DeliveryWork[]>;
  /** Pushes the lease forward before a send; the new lease, or null when the delivery is no longer ours. */
  renew(
    tenantId: string,
    deliveryId: string,
    lease: string | null,
    now: Date,
    leaseMs: number,
  ): Promise<string | null>;
  /** Writes the outcome only while the delivery is still open and still under `lease`; false otherwise. */
  settle(
    tenantId: string,
    deliveryId: string,
    outcome: AttemptOutcome,
    at: string,
    lease: string | null,
  ): Promise<boolean>;
  /** Deliveries claimed or attempted since `since`: the window of the per-minute limit. */
  attemptsSince(tenantId: string, since: Date): Promise<number>;
  /** Counts the result on the endpoint; `disabled` is true only for the call that switched it off. */
  noteResult(
    tenantId: string,
    endpointId: string,
    ok: boolean,
    at: string,
  ): Promise<{ readonly disabled: boolean }>;
  /** Removes deliveries created before `before`; returns how many. */
  purge(tenantId: string, before: Date): Promise<number>;

  driverState(tenantId: string, driverId: string): Promise<DriverState | null>;
  saveDriverState(state: DriverState): Promise<void>;
}

/** Tells the administrators that an endpoint was switched off (MVP-NOTIFY's channel). */
export interface EndpointNotifier {
  disabled(tenantId: string, endpointId: string): Promise<void>;
}
