import type { ActorRef } from './identity.js';

export interface ContractValidationError {
  path: string;
  code: string;
  message: string;
}

export const keys = (
  v: Record<string, unknown>,
  allowed: readonly string[],
  e: ContractValidationError[],
) =>
  Object.keys(v)
    .filter((k) => !allowed.includes(k))
    .forEach((path) =>
      e.push({ path, code: 'unknown_property', message: 'property is not allowed' }),
    );
export const actor = (v: unknown): v is ActorRef =>
  r(v) && t(v.subject) && (['user', 'api_key', 'system'] as string[]).includes(String(v.kind));
export const U = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  I = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/,
  H = /^[a-f0-9]{64}$/i;
export type R = Record<string, unknown>;
export const r = (v: unknown): v is R => typeof v === 'object' && v !== null && !Array.isArray(v),
  t = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0,
  u = (v: unknown): v is string => typeof v === 'string' && U.test(v),
  i = (v: unknown): v is string => {
    if (typeof v !== 'string') return false;
    const m = I.exec(v);
    if (!m) return false;
    const d = Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6]),
      Number(m[7] ?? 0),
    );
    const x = new Date(d);
    return (
      x.getUTCFullYear() === Number(m[1]) &&
      x.getUTCMonth() === Number(m[2]) - 1 &&
      x.getUTCDate() === Number(m[3]) &&
      x.getUTCHours() === Number(m[4]) &&
      x.getUTCMinutes() === Number(m[5]) &&
      x.getUTCSeconds() === Number(m[6])
    );
  };
