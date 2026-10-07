import type { IdentityStoreErrorCode } from './errors.js';

export interface StoreErrorEvent {
  readonly operation: string;
  readonly code: IdentityStoreErrorCode;
  readonly errno: number | null;
  /** Class name of a non-driver cause (`internal` only). */
  readonly origin: string | null;
  readonly frames: readonly string[];
}

export interface TypeOrmIdentityStoreOptions {
  readonly now?: () => Date;
  /** Total attempts for a transaction that hits a deadlock or lock-wait timeout (default 3). */
  readonly maxAttempts?: number;
  readonly onError?: (event: StoreErrorEvent) => void;
}
