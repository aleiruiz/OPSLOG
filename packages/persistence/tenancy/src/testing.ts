import type { TenantContext } from '@opslog/domain-tenants';
import { markTrustedContext } from './trusted-context.js';

/** Test-only: marks a hand-built context as resolver-issued. Not exported from the package entry point. */
export function trustContextForTests(context: TenantContext): TenantContext {
  return markTrustedContext(context);
}
