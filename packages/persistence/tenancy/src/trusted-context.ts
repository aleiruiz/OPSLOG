import type { TenantContext } from '@opslog/domain-tenants';

/** Contexts issued by TenantContextResolver; `acquire` rejects any object that is not in this set. */
const trusted = new WeakSet<TenantContext>();

export function markTrustedContext(context: TenantContext): TenantContext {
  trusted.add(context);
  return context;
}

export function isTrustedContext(context: TenantContext): boolean {
  return trusted.has(context);
}
