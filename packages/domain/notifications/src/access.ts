import { canView } from '../../incidents/cases/src/index.js';
import { EVENT_KINDS, KINDS, type EventKind, type Requirement } from './catalog.js';
import type { MemberAccess } from './ports.js';

const has = (access: MemberAccess, permission: string): boolean =>
  (access.permissions as readonly string[]).includes(permission);

/** Whether the member holds the right a requirement names, as it is now. */
export function meets(access: MemberAccess, requirement: Requirement): boolean {
  if (requirement === null) return true;
  if (requirement === 'view') return has(access, 'view');
  // Same rule as the incident screens: `incidents:view`, and a mechanic is scoped out (ADR-0014).
  return canView({
    id: '',
    subject: '',
    permissions: access.permissions,
    mechanicLinked: access.mechanicLinked,
  });
}

/** The kinds of notice the member may see now. A notice of another kind stays hidden even if it exists. */
export function kindsFor(access: MemberAccess): readonly EventKind[] {
  return EVENT_KINDS.filter((kind) => meets(access, KINDS[kind].requires));
}

export const holds = has;
