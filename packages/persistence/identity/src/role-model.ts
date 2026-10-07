import { ROLE_PATTERN } from './store-support.js';

export const ADMIN_ROLE = 'admin';
/** Least privilege: a membership created through the plain `IdentityStore` port has no elevated role. */
export const DEFAULT_ROLE = 'viewer';

export const CUSTOM_ROLE_LIMITS = { nameLength: 80, permissions: 64 } as const;

/** A custom role of one tenant (a copy of a system template); permissions keep their stored order. */
export interface CustomRoleRecord {
  readonly id: string;
  readonly name: string;
  readonly permissions: readonly string[];
}

export type CreateCustomRoleOutcome = 'created' | 'name_taken' | 'limit_reached';

export const isRoleName = (value: unknown): value is string =>
  typeof value === 'string' && ROLE_PATTERN.test(value);
