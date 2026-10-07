import type { Employee, EmployeesPort } from './types';

/**
 * In-memory employees with the semantics of the real backend (`packages/domain/employees` and the
 * `EmployeesApi` composition): optimistic versions (409 `stale_version`), read-only archived and terminated
 * employees (409 `immutable`), a status matrix (409 `invalid_transition`), per-company uniqueness of employee
 * number, identification and e-mail (409 `duplicate` with the colliding field), an active area of the company
 * (422 `invalid_area`), personal data that only `get` returns and only to a session with `view_pii`, a history of
 * status and area changes, and a uniform 400/404. Operation permissions are enforced by the caller (`mockApi`);
 * the PII permission needed to write personal data is part of that check, like on the server.
 */
export interface MockEmployeeStore {
  readonly port: EmployeesPort;
  /** Another actor changes the employee on the server: bumps its version, so the caller's copy is stale. */
  changeExternally(id: string, change: Partial<Pick<Employee, 'position' | 'firstName'>>): void;
  /** Another actor archives the employee on the server. */
  archiveExternally(id: string): void;
  /** Another actor terminates the employee on the server. */
  terminateExternally(id: string): void;
  /** Employees currently on the server (no personal data), for assertions. */
  snapshot(): readonly Employee[];
  /** Every audit event the server recorded: action and entity id, never a value. */
  auditLog(): readonly { readonly action: EmployeeAuditAction; readonly id: string }[];
  /** Employees of the area that still count as assigned people (BR-021): not archived, not terminated. */
  countLiveInArea(areaId: string): number;
}

export type EmployeeAuditAction =
  | 'employee.created'
  | 'employee.updated'
  | 'employee.status_changed'
  | 'employee.archived'
  | 'employee.pii_viewed';

export interface MockEmployeeEnvironment {
  /** Whether an area id is an active area of the company (like the backend, which refuses any other). */
  readonly isActiveArea: (areaId: string) => boolean;
  /** Whether the signed-in session holds `view_pii`. */
  readonly canViewPii: () => boolean;
  /** The signed-in user, recorded in the history. */
  readonly actorId: () => string;
}
