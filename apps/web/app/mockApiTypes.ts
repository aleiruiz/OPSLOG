import type { ApiError } from '@opslog/contracts';
import type { EmployeeAuditAction } from './mockEmployees';
import type {
  ApiPorts,
  Area,
  Document,
  DraftValues,
  Employee,
  EmployeeDetail,
  InsurancePolicy,
  Permission,
  Result,
  UserSummary,
  Vehicle,
} from './types';

export type MockOperation =
  | 'getSession'
  | 'login'
  | 'logout'
  | 'inspectInvitation'
  | 'acceptInvitation'
  | 'getCompanySettings'
  | 'updateCompanySettings'
  | 'listUsers'
  | 'inviteUser'
  | 'deactivateUser'
  | 'listRoles'
  | 'copyRole'
  | 'loadDraft'
  | 'saveDraft'
  | 'discardDraft'
  | 'listVehicles'
  | 'getVehicle'
  | 'createVehicle'
  | 'updateVehicle'
  | 'recordOdometer'
  | 'archiveVehicle'
  | 'listAreas'
  | 'getArea'
  | 'createArea'
  | 'updateArea'
  | 'deactivateArea'
  | 'activateArea'
  | 'areaHistory'
  | 'listDocuments'
  | 'getDocument'
  | 'createDocument'
  | 'updateDocument'
  | 'renewDocument'
  | 'archiveDocument'
  | 'documentHistory'
  | 'listPolicies'
  | 'getPolicy'
  | 'createPolicy'
  | 'updatePolicy'
  | 'renewPolicy'
  | 'archivePolicy'
  | 'policyHistory'
  | 'listEmployees'
  | 'getEmployee'
  | 'createEmployee'
  | 'updateEmployee'
  | 'changeEmployeeStatus'
  | 'archiveEmployee'
  | 'employeeHistory';

export interface MockControls {
  /** Simulates the server-side session expiring (cookie no longer valid). */
  expireSession(): void;
  /** Makes the next call of `operation` fail with the given status. */
  failNext(operation: MockOperation, status?: ApiError['status']): void;
  isSignedIn(): boolean;
  /** Simulates a server-side status change of a user (e.g. suspension) without a UI path. */
  setUserStatus(userId: string, status: UserSummary['status']): void;
  /** Server-side drafts of the current user, for assertions. */
  storedDrafts(): Readonly<Record<string, DraftValues>>;
  /** Another actor edits a vehicle on the server: its version moves on, so a form that loaded it is stale. */
  changeVehicleExternally(
    id: string,
    change: Partial<Pick<Vehicle, 'odometerKm' | 'make' | 'model'>>,
  ): void;
  /** Another actor archives a vehicle on the server. */
  archiveVehicleExternally(id: string): void;
  /** Vehicles currently on the server, for assertions. */
  vehicles(): readonly Vehicle[];
  /** Another actor renames an area on the server: its version moves on, so a form that loaded it is stale. */
  changeAreaExternally(id: string, change: { name: string }): void;
  /** Another actor deactivates an area on the server. */
  deactivateAreaExternally(id: string): void;
  /** Active people the (not yet built) personnel module reports for an area: they block its deactivation. */
  setAreaPeople(id: string, people: number): void;
  /** Areas currently on the server, for assertions. */
  areas(): readonly Area[];
  /** Another actor edits a document on the server: its version moves on, so a form that loaded it is stale. */
  changeDocumentExternally(id: string, change: Partial<Pick<Document, 'title' | 'notes'>>): void;
  /** Another actor archives a document on the server. */
  archiveDocumentExternally(id: string): void;
  /** Documents currently on the server, for assertions. */
  documents(): readonly Document[];
  /** Another actor edits a policy on the server: its version moves on, so a form that loaded it is stale. */
  changePolicyExternally(id: string, change: Partial<Pick<InsurancePolicy, 'insurer'>>): void;
  /** Another actor archives a policy on the server. */
  archivePolicyExternally(id: string): void;
  /** Policies currently on the server, deductible included, for assertions. */
  policies(): readonly InsurancePolicy[];
  /** Another actor edits an employee on the server: its version moves on, so a form that loaded it is stale. */
  changeEmployeeExternally(
    id: string,
    change: Partial<Pick<Employee, 'position' | 'firstName'>>,
  ): void;
  /** Another actor archives an employee on the server. */
  archiveEmployeeExternally(id: string): void;
  /** Another actor terminates an employee on the server. */
  terminateEmployeeExternally(id: string): void;
  /** Employees currently on the server (no personal data), for assertions. */
  employees(): readonly Employee[];
  /** The server's audit trail of employee events (action and entity id, never a value), for assertions. */
  employeeAudit(): readonly { readonly action: EmployeeAuditAction; readonly id: string }[];
}

export interface MockApi extends ApiPorts {
  readonly controls: MockControls;
}

export interface MockApiOptions {
  /** Initial fleet: the synthetic demo fleet by default; pass `[]` for a company without vehicles. */
  readonly vehicles?: readonly Vehicle[];
  /** Initial areas: the synthetic demo tree by default; pass `[]` for a company without areas. */
  readonly areas?: readonly Area[];
  /** Initial documents: the synthetic demo set by default; pass `[]` for a company without documents. */
  readonly documents?: readonly Document[];
  /** Initial policies: the synthetic demo set by default; pass `[]` for a company without policies. */
  readonly policies?: readonly InsurancePolicy[];
  /** Initial staff with their personal data: the synthetic demo staff by default; pass `[]` for none. */
  readonly employees?: readonly EmployeeDetail[];
}

/** Runs `action` only for a live session holding `permission` (when given). */
export type Guarded = <T>(
  operation: MockOperation,
  permission: Permission | readonly Permission[] | null,
  action: () => Result<T> | Promise<Result<T>>,
) => Promise<Result<T>>;
