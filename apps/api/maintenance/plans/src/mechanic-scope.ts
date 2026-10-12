import type { TenantContext } from '../../../../../packages/domain/identity/src/index.js';
import type { Mechanic } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';
import type { Workshop } from '../../../../../packages/domain/maintenance/workshops/src/index.js';

/**
 * SPECS D9 read scope of a mechanic-scoped caller (a member linked to a mechanic record without
 * fleet `edit`). Decided here, in one place:
 * - plans, schedules and scheduled orders: none (not_found / empty list); the assigned orders are
 *   reached through the work order API, which already filters by assignment;
 * - mechanics: only the caller's own records (the web shell needs them to find "Mis órdenes");
 * - workshops: only the workshops of the caller's own mechanics, without the contact field.
 */
export interface MaintenanceScope {
  /** Resolves the caller's mechanic scope from the session; `null` means the full catalog. */
  readonly resolve: (context: TenantContext) => Promise<{ readonly scoped: boolean }>;
}

export const ownMechanics = (all: readonly Mechanic[], subject: string): readonly Mechanic[] =>
  all.filter((m) => m.kind === 'internal' && m.memberId === subject);

export const visibleWorkshops = (
  all: readonly Workshop[],
  own: readonly Mechanic[],
): readonly Workshop[] => {
  const ids = new Set(own.flatMap((m) => (m.workshopId === null ? [] : [m.workshopId])));
  return all.filter((w) => ids.has(w.id)).map((w) => ({ ...w, contact: null }));
};
