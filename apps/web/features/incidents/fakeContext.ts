import type {
  ApiError,
  BffIncident,
  BffIncidentEvidence,
  BffIncidentTimelineEntry,
  BffThirdParty,
} from '@opslog/contracts';
import type { Result } from '../../app/types';
import type { Writable } from './types';

export type Setting<T> = T | (() => T);
export const read = <T>(value: Setting<T>): T =>
  typeof value === 'function' ? (value as () => T)() : value;

export const fail = (
  status: ApiError['status'],
  code: string,
  extra: Partial<ApiError> = {},
): Result<never> => ({
  ok: false,
  error: { status, code, message: 'x', correlationId: 'fake', ...extra },
});
export const ok = <T>(value: T): Result<T> => ({ ok: true, value: structuredClone(value) });

/** The object without the given keys (so a value can be set aside without an unused variable). */
export function omit<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

/** One stored case with what hangs from it. */
export interface Record_ {
  incident: BffIncident;
  timeline: BffIncidentTimelineEntry[];
  parties: (BffThirdParty & {
    secret: {
      name: string | null;
      contact: string | null;
      plates: string | null;
      policyNumber: string | null;
    };
  })[];
  evidence: BffIncidentEvidence[];
}

export const isFailure = (value: Record_ | Result<never>): value is Result<never> => 'ok' in value;

/** What the children's stand-in needs from the case stand-in: the same checks every write goes through. */
export interface FakeContext {
  injected(name: string): Result<never> | null;
  visible(id: string): Record_ | null;
  guard(id: string, version: number): Record_ | Result<never>;
  commit(record: Record_, changes: Writable<BffIncident>): BffIncident;
  entry(record: Record_, command: string, changed: string[], comment?: string | null): void;
  viewPii(): boolean;
}
