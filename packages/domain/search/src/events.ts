/** Outbox event that brings the projection of one company to the current state of the modules. */
export const SEARCH_RECONCILE_EVENT = 'search.reconcile';
/** The system actor the reconcile events are written under; the worker does not gate it by role. */
export const SEARCH_EVENT_ACTOR = 'system:search';

export interface ReconcileJob {
  readonly tenantId: string;
  /** Opaque id; the same id twice is the same job (the outbox deduplicates by it). */
  readonly jobId: string;
  /** ISO instant the job was queued. */
  readonly at: string;
  /** Rewrites every entity instead of only the changed ones. */
  readonly full?: boolean;
}

/** Where reconcile jobs are queued: the durable outbox of the company. */
export interface ReconcileQueue {
  enqueueReconcile(job: ReconcileJob): Promise<void>;
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
export const isOpaqueJobId = (value: unknown): value is string =>
  typeof value === 'string' && OPAQUE_ID.test(value);

/** The payload of a reconcile event: only the optional `full` flag, nothing else. */
export function parseReconcilePayload(payload: unknown): { readonly full: boolean } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    throw new Error('invalid search reconcile job');
  const fields = payload as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.some((key) => key !== 'full')) throw new Error('invalid search reconcile job');
  if (fields['full'] !== undefined && typeof fields['full'] !== 'boolean')
    throw new Error('invalid search reconcile job');
  return { full: fields['full'] === true };
}
