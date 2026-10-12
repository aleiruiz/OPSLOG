import type { Mechanic } from '../../../../../packages/domain/maintenance/mechanics/src/index.js';

/** The slice of the mechanics store the D9 scope needs. */
export interface MechanicDirectory {
  list(tenantId: string): Promise<readonly Mechanic[]>;
}

export interface MechanicScope {
  /** Active internal mechanics linked to the member: the orders they may reach. */
  readonly mechanicIdsOfMember: (tenantId: string, memberId: string) => Promise<readonly string[]>;
  /**
   * Whether the member has any internal mechanic record, active or not. Records are never deleted
   * and `memberId` is immutable, so this is a stable source of scope: deactivating the link leaves
   * the member scoped to an empty set instead of widening access to every order (SPECS D9).
   */
  readonly mechanicLinked: (tenantId: string, memberId: string) => Promise<boolean>;
}

/** The single implementation of the member -> mechanic linkage, shared by every maintenance API. */
export function createMechanicScope(mechanics: MechanicDirectory): MechanicScope {
  const linkedRecords = async (tenantId: string, memberId: string) =>
    (await mechanics.list(tenantId)).filter(
      (m) => m.kind === 'internal' && m.memberId === memberId,
    );
  return {
    mechanicIdsOfMember: async (tenantId, memberId) =>
      (await linkedRecords(tenantId, memberId)).filter((m) => m.active).map((m) => m.id),
    mechanicLinked: async (tenantId, memberId) =>
      (await linkedRecords(tenantId, memberId)).length > 0,
  };
}
