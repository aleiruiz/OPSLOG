import type { ISODateTime, Page, Permission } from './index.js';

/**
 * Single source of truth for the HTTP surface between the web app and the BFF (`apps/api/bff`).
 * The BFF builds its routing table from `BFF_ROUTES` and types its responses with `BffRouteTypes`;
 * the web client (`apps/web/api`) derives every call from the same two. Anything that is not
 * declared here is not part of the contract, and a drift test (tests/integration/platform) fails
 * when the BFF and this module disagree.
 */

export const CSRF_HEADER = 'x-csrf-token';

export type BffMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** How a route is protected. `session-csrf` also requires the session-bound token on state changes. */
export type BffRouteKind = 'public' | 'pre-session' | 'session' | 'session-csrf';

/** Uniform error bodies: fixed texts, never anything from the request, a stack or a store. */
export const BFF_ERRORS = {
  bad_request: { status: 400, message: 'Invalid request' },
  unauthorized: { status: 401, message: 'Authentication required' },
  forbidden: { status: 403, message: 'Permission denied' },
  csrf_failed: { status: 403, message: 'Request rejected' },
  not_found: { status: 404, message: 'Resource not found' },
  method_not_allowed: { status: 405, message: 'Method not allowed' },
  conflict: { status: 409, message: 'Conflict' },
  last_admin: { status: 409, message: 'Conflict' },
  duplicate: { status: 409, message: 'Conflict' },
  stale_version: { status: 409, message: 'Conflict' },
  invalid_transition: { status: 409, message: 'Conflict' },
  immutable: { status: 409, message: 'Conflict' },
  area_in_use: { status: 409, message: 'Conflict' },
  principal_taken: { status: 409, message: 'Conflict' },
  already_assigned: { status: 409, message: 'Conflict' },
  odometer_decrease: { status: 422, message: 'Unprocessable request' },
  invalid_area: { status: 422, message: 'Unprocessable request' },
  invalid_owner: { status: 422, message: 'Unprocessable request' },
  invalid_vehicle: { status: 422, message: 'Unprocessable request' },
  invalid_employee: { status: 422, message: 'Unprocessable request' },
  invalid_hierarchy: { status: 422, message: 'Unprocessable request' },
  invalid_responsible: { status: 422, message: 'Unprocessable request' },
  payload_too_large: { status: 413, message: 'Payload too large' },
  unsupported_media_type: { status: 415, message: 'Unsupported media type' },
  internal_error: { status: 500, message: 'Request failed' },
} as const;

export type BffErrorCode = keyof typeof BFF_ERRORS;

export interface BffErrorBody {
  readonly code: BffErrorCode;
  readonly status: number;
  readonly message: string;
  readonly correlationId: string;
  /**
   * Only on `duplicate` (the unique field that collided: `economic_number`, `plate`, `vin`,
   * `employee_number`, `national_id` or `email`), `area_in_use` (the kind of resource that blocks:
   * `sub_areas`, `vehicles` or `people`), `invalid_area` (`area_id`), `invalid_owner`
   * (`owner_id`), `invalid_vehicle` (`vehicle_id`), `invalid_employee` (`employee_id`),
   * `principal_taken` (`vehicle_id` when the vehicle already has a current principal,
   * `employee_id` when the driver is already principal of another vehicle) and `already_assigned`
   * (`employee_id`); never a value or a count.
   */
  readonly field?: string;
}

export const isBffErrorBody = (value: unknown): value is BffErrorBody => {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Partial<BffErrorBody>;
  return (
    typeof body.code === 'string' &&
    Object.hasOwn(BFF_ERRORS, body.code) &&
    typeof body.status === 'number' &&
    typeof body.message === 'string' &&
    typeof body.correlationId === 'string' &&
    (body.field === undefined || typeof body.field === 'string')
  );
};

export type BffMfaPolicy = 'disabled' | 'optional' | 'required';
export type BffUserStatus = 'active' | 'invited' | 'inactive';

/** The browser never receives names or emails: identities are opaque ids. */
export interface BffUser {
  readonly id: string;
  readonly roleId: string;
  readonly roleLabel: string;
  readonly status: BffUserStatus;
}

export interface BffCsrfResponse {
  readonly csrfToken: string;
}

/** OIDC authorization result obtained by the browser from the identity provider. */
export interface BffOidcCredentials {
  readonly code: string;
  readonly nonce: string;
}

export interface BffSession {
  readonly company: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string };
  readonly roleId: string;
  readonly roleLabel: string;
  readonly permissions: readonly Permission[];
  readonly expiresAt: ISODateTime;
  readonly csrfToken: string;
}

export interface BffInvitationPreview {
  readonly companyName: string;
  readonly roleLabel: string;
}

export interface BffSettings {
  readonly name: string;
  readonly status: 'active' | 'suspended';
  readonly mfa: BffMfaPolicy;
  readonly sessionIdleHours: number;
}

export interface BffSettingsInput {
  readonly name: string;
  readonly mfa: BffMfaPolicy;
  readonly sessionIdleHours: number;
  /** Required by the server when a security setting changes. */
  readonly reason?: string;
}

export interface BffUsersQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly sort?: 'id' | 'roleLabel' | 'status';
  readonly direction?: 'asc' | 'desc';
  readonly search?: string;
}

export interface BffInviteResponse {
  readonly user: { readonly id: string; readonly roleId: string; readonly status: 'invited' };
  /** Delivery by email is not built yet: the administrator who invites receives the token. */
  readonly invitationToken: string;
  readonly expiresAt: ISODateTime;
}

export interface BffRole {
  readonly id: string;
  readonly name: string;
  readonly kind: 'system' | 'custom';
  readonly permissions: readonly Permission[];
  readonly memberCount: number;
}

export interface BffDraft {
  readonly scope: string;
  readonly values: Readonly<Record<string, string>>;
  readonly savedAt: ISODateTime;
}

export const BFF_VEHICLE_STATUSES = [
  'active',
  'restricted',
  'in_maintenance',
  'out_of_service',
  'inactive',
  'decommissioned',
] as const;
export type BffVehicleStatus = (typeof BFF_VEHICLE_STATUSES)[number];

/** A fleet vehicle. The company is implicit (the session's); `version` is the concurrency token. */
export interface BffVehicle {
  readonly id: string;
  readonly economicNumber: string;
  readonly plate: string;
  readonly vin: string | null;
  readonly make: string;
  readonly model: string;
  readonly year: number;
  readonly areaId: string;
  readonly status: BffVehicleStatus;
  readonly statusReason: string;
  readonly odometerKm: number;
  /** `YYYY-MM-DD`. */
  readonly registeredOn: string;
  readonly version: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly archivedAt: ISODateTime | null;
}

export interface BffVehicleInput {
  readonly economicNumber: string;
  readonly plate: string;
  readonly vin?: string | null;
  readonly make: string;
  readonly model: string;
  readonly year: number;
  readonly areaId: string;
  readonly odometerKm: number;
  /** `YYYY-MM-DD`, not in the future; defaults to today. */
  readonly registeredOn?: string;
}

/** Fields that can be edited in place; at least one besides `version`. Status and odometer have their own commands. */
export interface BffVehiclePatch {
  readonly version: number;
  readonly economicNumber?: string;
  readonly plate?: string;
  readonly vin?: string | null;
  readonly make?: string;
  readonly model?: string;
  readonly year?: number;
  readonly areaId?: string;
}

export interface BffVehiclesQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly status?: BffVehicleStatus;
  readonly areaId?: string;
  /** `true` to include archived vehicles (default: hidden). */
  readonly includeArchived?: 'true' | 'false';
}

export interface BffVehicleStatusEntry {
  readonly id: string;
  readonly from: BffVehicleStatus | null;
  readonly to: BffVehicleStatus;
  readonly reason: string;
  readonly actorId: string;
  readonly version: number;
  readonly at: ISODateTime;
}

export const BFF_EMPLOYEE_KINDS = ['driver', 'dispatcher', 'other'] as const;
export type BffEmployeeKind = (typeof BFF_EMPLOYEE_KINDS)[number];

export const BFF_EMPLOYEE_STATUSES = ['active', 'inactive', 'suspended', 'terminated'] as const;
export type BffEmployeeStatus = (typeof BFF_EMPLOYEE_STATUSES)[number];

/** Which personal data an employee has on file. Presence only, never a value. */
export interface BffEmployeePiiPresent {
  readonly nationalId: boolean;
  readonly phone: boolean;
  readonly email: boolean;
  readonly licenseNumber: boolean;
}

/** Why a driver is not fit to operate (BR-012); several can apply at once. */
export type BffFitnessReason = 'not_active' | 'archived' | 'license_missing' | 'license_expired';

/** Derived fitness to operate. `null` on the employee when the kind has none (not a driver). */
export interface BffFitness {
  readonly fit: boolean;
  readonly reasons: readonly BffFitnessReason[];
}

/**
 * A person of the company's staff. The company is implicit (the session's); `version` is the
 * concurrency token. Personal data never appears here: only `piiPresent` flags and the
 * non-sensitive `idType`, `licenseType` and `licenseExpiresOn`.
 */
export interface BffEmployee {
  readonly id: string;
  readonly kind: BffEmployeeKind;
  readonly firstName: string;
  readonly lastName: string;
  readonly employeeNumber: string | null;
  readonly position: string | null;
  /** `YYYY-MM-DD`. */
  readonly hireDate: string | null;
  readonly areaId: string;
  readonly status: BffEmployeeStatus;
  readonly statusReason: string;
  /** Identification type (catalog code); the number is personal data. */
  readonly idType: string | null;
  /** Driver only. */
  readonly licenseType: string | null;
  /** Driver only, `YYYY-MM-DD`; the last valid day, inclusive. */
  readonly licenseExpiresOn: string | null;
  readonly piiPresent: BffEmployeePiiPresent;
  readonly fitness: BffFitness | null;
  readonly version: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly archivedAt: ISODateTime | null;
}

/** Decrypted personal data, normalized (upper-case ids, E.164 phone, lower-case e-mail). */
export interface BffEmployeePii {
  readonly nationalId: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly licenseNumber: string | null;
}

/**
 * The single-employee read. `pii` is `null` (masked) unless the session holds the PII permission;
 * a read that returns personal data is audited.
 */
export interface BffEmployeeDetail extends BffEmployee {
  readonly pii: BffEmployeePii | null;
}

/**
 * Creating an employee. `idType` and `nationalId` go together; the license fields are for drivers
 * only. Sending any of `idType`, `nationalId`, `phone`, `email` or `licenseNumber` also requires
 * the PII permission.
 */
export interface BffEmployeeInput {
  readonly kind: BffEmployeeKind;
  readonly firstName: string;
  readonly lastName: string;
  readonly areaId: string;
  readonly employeeNumber?: string | null;
  readonly position?: string | null;
  /** `YYYY-MM-DD`, not in the future. */
  readonly hireDate?: string | null;
  readonly idType?: string | null;
  readonly nationalId?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly licenseNumber?: string | null;
  readonly licenseType?: string | null;
  readonly licenseExpiresOn?: string | null;
}

/**
 * Fields that can be edited in place (never `kind`); at least one besides `version`, `null` clears
 * an optional field. A different `areaId` moves the employee (recorded in the history).
 */
export interface BffEmployeePatch extends Partial<Omit<BffEmployeeInput, 'kind'>> {
  readonly version: number;
}

export interface BffEmployeesQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly kind?: BffEmployeeKind;
  readonly status?: BffEmployeeStatus;
  readonly areaId?: string;
  /** `true` to include archived employees (default: hidden). */
  readonly includeArchived?: 'true' | 'false';
}

/** `status` entries carry the reason and the status ids; `area` entries carry the area ids and no reason. */
export interface BffEmployeeHistoryEntry {
  readonly id: string;
  readonly kind: 'status' | 'area';
  readonly from: string | null;
  readonly to: string;
  readonly reason: string | null;
  /** `user-<subject>`: the only identifier of a person in the row. */
  readonly actorId: string;
  readonly version: number;
  readonly at: ISODateTime;
}

export interface BffEmployeeHistoryQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
}

export const BFF_DOCUMENT_OWNER_TYPES = ['vehicle', 'employee'] as const;
export type BffDocumentOwnerType = (typeof BFF_DOCUMENT_OWNER_TYPES)[number];

/** Derived from the expiry date and the server clock; never stored. */
export const BFF_DOCUMENT_STATUSES = ['valid', 'expiring', 'expired'] as const;
export type BffDocumentStatus = (typeof BFF_DOCUMENT_STATUSES)[number];

/** Status of a revision in the history: the current one is derived, older ones are `replaced`. */
export type BffDocumentRevisionStatus = BffDocumentStatus | 'replaced';

/**
 * A document of a vehicle or an employee: metadata only (files arrive with the files module). The
 * company is implicit (the session's); `version` is the concurrency token. The validity fields
 * (`issuedOn`, `expiresOn`, `documentNumber`) belong to the current `revision`; renewing appends a
 * revision and keeps the earlier ones.
 */
export interface BffDocument {
  readonly id: string;
  readonly ownerType: BffDocumentOwnerType;
  readonly ownerId: string;
  /** Catalog code, valid for the owner type (for example `registration_card` or `medical_exam`). */
  readonly typeCode: string;
  readonly title: string;
  readonly notes: string | null;
  readonly revision: number;
  /** `YYYY-MM-DD`. */
  readonly issuedOn: string | null;
  /** `YYYY-MM-DD`; the last valid day, inclusive. */
  readonly expiresOn: string | null;
  readonly documentNumber: string | null;
  readonly status: BffDocumentStatus;
  /** Whole days to the last valid day (0 on that day, negative once expired); `null` without expiry. */
  readonly daysToExpiry: number | null;
  readonly version: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly archivedAt: ISODateTime | null;
}

/**
 * Creating a document. Types that must expire (for example `registration_card`) require
 * `expiresOn`; `expiresOn` is never before `issuedOn`, and `issuedOn` is not in the future.
 */
export interface BffDocumentInput {
  readonly ownerType: BffDocumentOwnerType;
  readonly ownerId: string;
  readonly typeCode: string;
  readonly title: string;
  readonly notes?: string | null;
  readonly issuedOn?: string | null;
  readonly expiresOn?: string | null;
  readonly documentNumber?: string | null;
}

/** Only the title and the notes can be edited in place; at least one besides `version`. */
export interface BffDocumentPatch {
  readonly version: number;
  readonly title?: string;
  readonly notes?: string | null;
}

/** A renewal: the validity data of the new revision. The owner, type and title stay. */
export interface BffDocumentRenewal {
  readonly version: number;
  readonly issuedOn?: string | null;
  readonly expiresOn?: string | null;
  readonly documentNumber?: string | null;
}

export interface BffDocumentsQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly ownerType?: BffDocumentOwnerType;
  /** Needs `ownerType`. */
  readonly ownerId?: string;
  readonly typeCode?: string;
  readonly status?: BffDocumentStatus;
  /** `true` to include archived documents (default: hidden). */
  readonly includeArchived?: 'true' | 'false';
}

export interface BffDocumentRevision {
  readonly revision: number;
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
  readonly documentNumber: string | null;
  readonly status: BffDocumentRevisionStatus;
  /** `user-<subject>`: the only identifier of a person in the row. */
  readonly actorId: string;
  readonly at: ISODateTime;
}

export interface BffDocumentHistoryQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
}

export const BFF_COVERAGE_TYPES = [
  'mandatory_liability',
  'third_party',
  'comprehensive',
  'other',
] as const;
export type BffCoverageType = (typeof BFF_COVERAGE_TYPES)[number];

/** Derived from the end date and the server clock; never stored. */
export const BFF_POLICY_STATUSES = ['valid', 'expiring', 'expired'] as const;
export type BffPolicyStatus = (typeof BFF_POLICY_STATUSES)[number];

/** Status of a revision in the history: the current one is derived, older ones are `replaced`. */
export type BffPolicyRevisionStatus = BffPolicyStatus | 'replaced';

/**
 * Deductible: an amount in the minor unit of an ISO 4217 currency (an integer, never a float) or
 * a percentage in basis points (1500 is 15 %). Financial data, gated by `view_costs`.
 */
export type BffDeductible =
  | { readonly kind: 'amount'; readonly amountMinor: number; readonly currency: string }
  | { readonly kind: 'percent'; readonly basisPoints: number };

/**
 * An insurance policy of a vehicle. The company is implicit (the session's); `version` is the
 * concurrency token. The period, the policy number, the coverage type and the deductible belong to
 * the current `revision`; renewing appends a revision and keeps the earlier ones. Without
 * `view_costs` the `deductible` is `null` and `hasDeductible` tells whether one exists.
 */
export interface BffInsurancePolicy {
  readonly id: string;
  readonly vehicleId: string;
  readonly insurer: string;
  readonly coverageNotes: string | null;
  readonly revision: number;
  readonly policyNumber: string;
  readonly coverageType: BffCoverageType;
  /** `YYYY-MM-DD`; the first day of coverage, inclusive. */
  readonly startsOn: string;
  /** `YYYY-MM-DD`; the last day of coverage, inclusive. */
  readonly endsOn: string;
  readonly status: BffPolicyStatus;
  /** Whole days to the last day of coverage (0 on that day, negative once expired). */
  readonly daysToExpiry: number;
  /** Whether the period contains today; a policy that has not started is `valid` but not covering. */
  readonly covering: boolean;
  readonly hasDeductible: boolean;
  readonly deductible: BffDeductible | null;
  readonly version: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly archivedAt: ISODateTime | null;
}

/** Creating a policy. A `deductible` needs `view_costs`; without one the policy has none. */
export interface BffInsurancePolicyInput {
  readonly vehicleId: string;
  readonly insurer: string;
  readonly coverageNotes?: string | null;
  readonly policyNumber: string;
  readonly coverageType: BffCoverageType;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly deductible?: BffDeductible | null;
}

/** Only the insurer name and the notes can be edited in place; at least one besides `version`. */
export interface BffInsurancePolicyPatch {
  readonly version: number;
  readonly insurer?: string;
  readonly coverageNotes?: string | null;
}

/**
 * A renewal: the new period is required. The policy number, the coverage type and the deductible
 * are carried over when omitted; an explicit `null` deductible removes it. Writing a deductible
 * needs `view_costs`.
 */
export interface BffInsurancePolicyRenewal {
  readonly version: number;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly policyNumber?: string;
  readonly coverageType?: BffCoverageType;
  readonly deductible?: BffDeductible | null;
}

export interface BffInsurancePoliciesQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly vehicleId?: string;
  readonly coverageType?: BffCoverageType;
  readonly status?: BffPolicyStatus;
  /** `YYYY-MM-DD`: only the policies whose period contains this day (BR-019). */
  readonly coversOn?: string;
  /** `true` to include archived policies (default: hidden). */
  readonly includeArchived?: 'true' | 'false';
}

export interface BffInsurancePolicyRevision {
  readonly revision: number;
  readonly policyNumber: string;
  readonly coverageType: BffCoverageType;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: BffPolicyRevisionStatus;
  readonly hasDeductible: boolean;
  readonly deductible: BffDeductible | null;
  /** `user-<subject>`: the only identifier of a person in the row. */
  readonly actorId: string;
  readonly at: ISODateTime;
}

export interface BffInsurancePolicyHistoryQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
}

export const BFF_ASSIGNMENT_TYPES = ['principal', 'secondary', 'temporary'] as const;
export type BffAssignmentType = (typeof BFF_ASSIGNMENT_TYPES)[number];

/** Derived from `endedAt`: `current` while the assignment has not ended. */
export const BFF_ASSIGNMENT_STATUSES = ['current', 'ended'] as const;
export type BffAssignmentStatus = (typeof BFF_ASSIGNMENT_STATUSES)[number];

/** How an assignment ended: closed by a person or replaced by a new principal. */
export type BffAssignmentEndKind = 'ended' | 'replaced';

/**
 * A driver-vehicle assignment. The company is implicit (the session's); `version` is the
 * concurrency token. An assignment is never edited or deleted: it is closed (`endedAt`) and stays
 * as history. `startedAt` is the server clock at the moment of assigning.
 */
export interface BffVehicleAssignment {
  readonly id: string;
  readonly vehicleId: string;
  readonly employeeId: string;
  readonly type: BffAssignmentType;
  readonly reason: string;
  /** `user-<subject>`: the only identifier of a person in the row. */
  readonly assignedBy: string;
  readonly startedAt: ISODateTime;
  readonly endedAt: ISODateTime | null;
  readonly endKind: BffAssignmentEndKind | null;
  readonly endReason: string | null;
  readonly endedBy: string | null;
  readonly current: boolean;
  readonly version: number;
  readonly updatedAt: ISODateTime;
}

/**
 * Assigning a driver (`employeeId` of an active employee of kind driver) to a vehicle (neither
 * archived, inactive nor decommissioned). A second principal is rejected with `principal_taken`;
 * `replace: true` (principal only; needs `edit` besides `create`) closes the vehicle's current
 * principal in the same transaction and returns it as `replaced`.
 */
export interface BffVehicleAssignmentInput {
  readonly vehicleId: string;
  readonly employeeId: string;
  readonly type: BffAssignmentType;
  readonly reason: string;
  readonly replace?: boolean;
}

export interface BffVehicleAssignmentCreated {
  readonly assignment: BffVehicleAssignment;
  readonly replaced: BffVehicleAssignment | null;
}

export interface BffVehicleAssignmentEnd {
  readonly version: number;
  readonly reason: string;
}

export interface BffVehicleAssignmentsQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  readonly vehicleId?: string;
  readonly employeeId?: string;
  readonly type?: BffAssignmentType;
  readonly status?: BffAssignmentStatus;
}

/** One row of the append-only history of an assignment. */
export interface BffVehicleAssignmentEvent {
  readonly seq: number;
  readonly kind: 'assigned' | BffAssignmentEndKind;
  readonly actorId: string;
  readonly reason: string;
  readonly at: ISODateTime;
}

export interface BffVehicleAssignmentHistoryQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
}

/** An area of the company's organizational tree (up to four levels). The company is implicit. */
export interface BffArea {
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  /** `null` for a root area. */
  readonly parentId: string | null;
  /** Level in the tree: 1 for a root, at most 4. */
  readonly depth: number;
  readonly active: boolean;
  /**
   * Responsible users as raw identity subjects (no `user-` prefix, unlike `BffAreaHistoryEntry.actorId`),
   * sorted. Names and emails never reach the browser.
   */
  readonly responsibleIds: readonly string[];
  readonly version: number;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
  readonly deactivatedAt: ISODateTime | null;
}

/** The single-area read adds the active resources that block its deactivation. */
export interface BffAreaDetail extends BffArea {
  readonly resourceCounts: { readonly vehicles: number; readonly people: number };
}

export interface BffAreaInput {
  readonly name: string;
  readonly code?: string | null;
  readonly parentId?: string | null;
  readonly responsibleIds?: readonly string[];
}

/** Fields that can be edited in place; at least one besides `version`. `parentId` moves the whole subtree. */
export interface BffAreaPatch {
  readonly version: number;
  readonly name?: string;
  readonly code?: string | null;
  readonly parentId?: string | null;
  readonly responsibleIds?: readonly string[];
}

export interface BffAreasQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
  /** An area id for its direct children, `root` for the roots; omitted for every level. */
  readonly parentId?: string;
  /** `true` to include deactivated areas (default: hidden). */
  readonly includeInactive?: 'true' | 'false';
}

export const BFF_AREA_ACTIONS = ['created', 'updated', 'activated', 'deactivated'] as const;
export type BffAreaAction = (typeof BFF_AREA_ACTIONS)[number];
export const BFF_AREA_FIELDS = ['name', 'code', 'parent', 'responsibles'] as const;
export type BffAreaField = (typeof BFF_AREA_FIELDS)[number];

/**
 * Who changed what and when. Field names only: no names, codes or responsible ids. `actorId` is the
 * acting user's id with the `user-` prefix (`user-<subject>`); `BffArea.responsibleIds` are the raw
 * identity subjects without that prefix.
 */
export interface BffAreaHistoryEntry {
  readonly id: string;
  readonly action: BffAreaAction;
  readonly fields: readonly BffAreaField[];
  readonly fromParentId: string | null;
  readonly toParentId: string | null;
  readonly actorId: string;
  readonly version: number;
  readonly at: ISODateTime;
}

export interface BffAreaHistoryQuery {
  readonly limit?: 25 | 50 | 100;
  readonly cursor?: string;
}

/** Request and response types of every route. Keys are route ids. */
export interface BffRouteTypes {
  'auth.csrf': { response: BffCsrfResponse };
  'auth.login': { body: BffOidcCredentials; response: BffSession };
  'auth.session': { response: BffSession };
  'auth.logout': { response: void };
  'auth.invitation.inspect': { body: { token: string }; response: BffInvitationPreview };
  'auth.invitation.accept': {
    body: BffOidcCredentials & { token: string };
    response: BffSession;
  };
  'company.settings.get': { response: BffSettings };
  'company.settings.update': { body: BffSettingsInput; response: BffSettings };
  'users.list': { query?: BffUsersQuery; response: Page<BffUser> };
  'users.invite': { body: { roleId: string }; response: BffInviteResponse };
  'users.deactivate': {
    params: { id: string };
    body: { reason: string };
    response: { id: string; status: 'inactive' };
  };
  'roles.list': { response: { items: readonly BffRole[] } };
  'roles.copy': { params: { id: string }; body: { name: string }; response: BffRole };
  'drafts.load': { params: { scope: string }; response: { draft: BffDraft | null } };
  'drafts.save': {
    params: { scope: string };
    body: { values: Readonly<Record<string, string>> };
    response: BffDraft;
  };
  'drafts.discard': { params: { scope: string }; response: void };
  'vehicles.list': { query?: BffVehiclesQuery; response: Page<BffVehicle> };
  'vehicles.create': { body: BffVehicleInput; response: BffVehicle };
  'vehicles.get': { params: { id: string }; response: BffVehicle };
  'vehicles.update': { params: { id: string }; body: BffVehiclePatch; response: BffVehicle };
  'vehicles.status': {
    params: { id: string };
    body: { version: number; status: BffVehicleStatus; reason: string };
    response: BffVehicle;
  };
  'vehicles.odometer': {
    params: { id: string };
    body: { version: number; odometerKm: number };
    response: BffVehicle;
  };
  'vehicles.archive': { params: { id: string }; body: { version: number }; response: BffVehicle };
  'vehicles.history': {
    params: { id: string };
    response: { items: readonly BffVehicleStatusEntry[] };
  };
  'employees.list': { query?: BffEmployeesQuery; response: Page<BffEmployee> };
  'employees.create': { body: BffEmployeeInput; response: BffEmployee };
  'employees.get': { params: { id: string }; response: BffEmployeeDetail };
  'employees.update': { params: { id: string }; body: BffEmployeePatch; response: BffEmployee };
  'employees.status': {
    params: { id: string };
    body: { version: number; status: BffEmployeeStatus; reason: string };
    response: BffEmployee;
  };
  'employees.archive': { params: { id: string }; body: { version: number }; response: BffEmployee };
  'employees.history': {
    params: { id: string };
    query?: BffEmployeeHistoryQuery;
    response: Page<BffEmployeeHistoryEntry>;
  };
  'documents.list': { query?: BffDocumentsQuery; response: Page<BffDocument> };
  'documents.create': { body: BffDocumentInput; response: BffDocument };
  'documents.get': { params: { id: string }; response: BffDocument };
  'documents.update': { params: { id: string }; body: BffDocumentPatch; response: BffDocument };
  'documents.renew': { params: { id: string }; body: BffDocumentRenewal; response: BffDocument };
  'documents.archive': { params: { id: string }; body: { version: number }; response: BffDocument };
  'insurance.list': { query?: BffInsurancePoliciesQuery; response: Page<BffInsurancePolicy> };
  'insurance.create': { body: BffInsurancePolicyInput; response: BffInsurancePolicy };
  'insurance.get': { params: { id: string }; response: BffInsurancePolicy };
  'insurance.update': {
    params: { id: string };
    body: BffInsurancePolicyPatch;
    response: BffInsurancePolicy;
  };
  'insurance.renew': {
    params: { id: string };
    body: BffInsurancePolicyRenewal;
    response: BffInsurancePolicy;
  };
  'insurance.archive': {
    params: { id: string };
    body: { version: number };
    response: BffInsurancePolicy;
  };
  'insurance.history': {
    params: { id: string };
    query?: BffInsurancePolicyHistoryQuery;
    response: Page<BffInsurancePolicyRevision>;
  };
  'assignments.list': {
    query?: BffVehicleAssignmentsQuery;
    response: Page<BffVehicleAssignment>;
  };
  'assignments.create': { body: BffVehicleAssignmentInput; response: BffVehicleAssignmentCreated };
  'assignments.get': { params: { id: string }; response: BffVehicleAssignment };
  'assignments.end': {
    params: { id: string };
    body: BffVehicleAssignmentEnd;
    response: BffVehicleAssignment;
  };
  'assignments.history': {
    params: { id: string };
    query?: BffVehicleAssignmentHistoryQuery;
    response: Page<BffVehicleAssignmentEvent>;
  };
  'documents.history': {
    params: { id: string };
    query?: BffDocumentHistoryQuery;
    response: Page<BffDocumentRevision>;
  };
  'areas.list': { query?: BffAreasQuery; response: Page<BffArea> };
  'areas.create': { body: BffAreaInput; response: BffArea };
  'areas.get': { params: { id: string }; response: BffAreaDetail };
  'areas.update': { params: { id: string }; body: BffAreaPatch; response: BffArea };
  'areas.deactivate': { params: { id: string }; body: { version: number }; response: BffArea };
  'areas.activate': { params: { id: string }; body: { version: number }; response: BffArea };
  'areas.history': {
    params: { id: string };
    query?: BffAreaHistoryQuery;
    response: Page<BffAreaHistoryEntry>;
  };
}

export type BffRouteId = keyof BffRouteTypes;

export interface BffRouteDefinition {
  readonly method: BffMethod;
  /** Path segments; `:name` is a parameter segment. */
  readonly path: readonly string[];
  readonly kind: BffRouteKind;
  /** Status of the successful response. */
  readonly status: 200 | 201 | 204;
}

export const BFF_ROUTES = {
  'auth.csrf': { method: 'GET', path: ['api', 'auth', 'csrf'], kind: 'public', status: 200 },
  'auth.login': {
    method: 'POST',
    path: ['api', 'auth', 'login'],
    kind: 'pre-session',
    status: 200,
  },
  'auth.session': {
    method: 'GET',
    path: ['api', 'auth', 'session'],
    kind: 'session',
    status: 200,
  },
  'auth.logout': {
    method: 'POST',
    path: ['api', 'auth', 'logout'],
    kind: 'session-csrf',
    status: 204,
  },
  'auth.invitation.inspect': {
    method: 'POST',
    path: ['api', 'auth', 'invitations', 'inspect'],
    kind: 'pre-session',
    status: 200,
  },
  'auth.invitation.accept': {
    method: 'POST',
    path: ['api', 'auth', 'invitations', 'accept'],
    kind: 'pre-session',
    status: 201,
  },
  'company.settings.get': {
    method: 'GET',
    path: ['api', 'company', 'settings'],
    kind: 'session',
    status: 200,
  },
  'company.settings.update': {
    method: 'PUT',
    path: ['api', 'company', 'settings'],
    kind: 'session-csrf',
    status: 200,
  },
  'users.list': { method: 'GET', path: ['api', 'users'], kind: 'session', status: 200 },
  'users.invite': {
    method: 'POST',
    path: ['api', 'users', 'invitations'],
    kind: 'session-csrf',
    status: 201,
  },
  'users.deactivate': {
    method: 'POST',
    path: ['api', 'users', ':id', 'deactivate'],
    kind: 'session-csrf',
    status: 200,
  },
  'roles.list': { method: 'GET', path: ['api', 'roles'], kind: 'session', status: 200 },
  'roles.copy': {
    method: 'POST',
    path: ['api', 'roles', ':id', 'copy'],
    kind: 'session-csrf',
    status: 201,
  },
  'drafts.load': {
    method: 'GET',
    path: ['api', 'drafts', ':scope'],
    kind: 'session',
    status: 200,
  },
  'drafts.save': {
    method: 'PUT',
    path: ['api', 'drafts', ':scope'],
    kind: 'session-csrf',
    status: 200,
  },
  'drafts.discard': {
    method: 'DELETE',
    path: ['api', 'drafts', ':scope'],
    kind: 'session-csrf',
    status: 204,
  },
  'vehicles.list': { method: 'GET', path: ['api', 'vehicles'], kind: 'session', status: 200 },
  'vehicles.create': {
    method: 'POST',
    path: ['api', 'vehicles'],
    kind: 'session-csrf',
    status: 201,
  },
  'vehicles.get': {
    method: 'GET',
    path: ['api', 'vehicles', ':id'],
    kind: 'session',
    status: 200,
  },
  'vehicles.update': {
    method: 'PUT',
    path: ['api', 'vehicles', ':id'],
    kind: 'session-csrf',
    status: 200,
  },
  'vehicles.status': {
    method: 'POST',
    path: ['api', 'vehicles', ':id', 'status'],
    kind: 'session-csrf',
    status: 200,
  },
  'vehicles.odometer': {
    method: 'POST',
    path: ['api', 'vehicles', ':id', 'odometer'],
    kind: 'session-csrf',
    status: 200,
  },
  'vehicles.archive': {
    method: 'POST',
    path: ['api', 'vehicles', ':id', 'archive'],
    kind: 'session-csrf',
    status: 200,
  },
  'vehicles.history': {
    method: 'GET',
    path: ['api', 'vehicles', ':id', 'history'],
    kind: 'session',
    status: 200,
  },
  'employees.list': { method: 'GET', path: ['api', 'employees'], kind: 'session', status: 200 },
  'employees.create': {
    method: 'POST',
    path: ['api', 'employees'],
    kind: 'session-csrf',
    status: 201,
  },
  'employees.get': {
    method: 'GET',
    path: ['api', 'employees', ':id'],
    kind: 'session',
    status: 200,
  },
  'employees.update': {
    method: 'PUT',
    path: ['api', 'employees', ':id'],
    kind: 'session-csrf',
    status: 200,
  },
  'employees.status': {
    method: 'POST',
    path: ['api', 'employees', ':id', 'status'],
    kind: 'session-csrf',
    status: 200,
  },
  'employees.archive': {
    method: 'POST',
    path: ['api', 'employees', ':id', 'archive'],
    kind: 'session-csrf',
    status: 200,
  },
  'employees.history': {
    method: 'GET',
    path: ['api', 'employees', ':id', 'history'],
    kind: 'session',
    status: 200,
  },
  'documents.list': { method: 'GET', path: ['api', 'documents'], kind: 'session', status: 200 },
  'documents.create': {
    method: 'POST',
    path: ['api', 'documents'],
    kind: 'session-csrf',
    status: 201,
  },
  'documents.get': {
    method: 'GET',
    path: ['api', 'documents', ':id'],
    kind: 'session',
    status: 200,
  },
  'documents.update': {
    method: 'PUT',
    path: ['api', 'documents', ':id'],
    kind: 'session-csrf',
    status: 200,
  },
  'documents.renew': {
    method: 'POST',
    path: ['api', 'documents', ':id', 'renew'],
    kind: 'session-csrf',
    status: 200,
  },
  'documents.archive': {
    method: 'POST',
    path: ['api', 'documents', ':id', 'archive'],
    kind: 'session-csrf',
    status: 200,
  },
  'documents.history': {
    method: 'GET',
    path: ['api', 'documents', ':id', 'history'],
    kind: 'session',
    status: 200,
  },
  'insurance.list': {
    method: 'GET',
    path: ['api', 'insurance-policies'],
    kind: 'session',
    status: 200,
  },
  'insurance.create': {
    method: 'POST',
    path: ['api', 'insurance-policies'],
    kind: 'session-csrf',
    status: 201,
  },
  'insurance.get': {
    method: 'GET',
    path: ['api', 'insurance-policies', ':id'],
    kind: 'session',
    status: 200,
  },
  'insurance.update': {
    method: 'PUT',
    path: ['api', 'insurance-policies', ':id'],
    kind: 'session-csrf',
    status: 200,
  },
  'insurance.renew': {
    method: 'POST',
    path: ['api', 'insurance-policies', ':id', 'renew'],
    kind: 'session-csrf',
    status: 200,
  },
  'insurance.archive': {
    method: 'POST',
    path: ['api', 'insurance-policies', ':id', 'archive'],
    kind: 'session-csrf',
    status: 200,
  },
  'insurance.history': {
    method: 'GET',
    path: ['api', 'insurance-policies', ':id', 'history'],
    kind: 'session',
    status: 200,
  },
  'assignments.list': {
    method: 'GET',
    path: ['api', 'vehicle-assignments'],
    kind: 'session',
    status: 200,
  },
  'assignments.create': {
    method: 'POST',
    path: ['api', 'vehicle-assignments'],
    kind: 'session-csrf',
    status: 201,
  },
  'assignments.get': {
    method: 'GET',
    path: ['api', 'vehicle-assignments', ':id'],
    kind: 'session',
    status: 200,
  },
  'assignments.end': {
    method: 'POST',
    path: ['api', 'vehicle-assignments', ':id', 'end'],
    kind: 'session-csrf',
    status: 200,
  },
  'assignments.history': {
    method: 'GET',
    path: ['api', 'vehicle-assignments', ':id', 'history'],
    kind: 'session',
    status: 200,
  },
  'areas.list': { method: 'GET', path: ['api', 'areas'], kind: 'session', status: 200 },
  'areas.create': {
    method: 'POST',
    path: ['api', 'areas'],
    kind: 'session-csrf',
    status: 201,
  },
  'areas.get': { method: 'GET', path: ['api', 'areas', ':id'], kind: 'session', status: 200 },
  'areas.update': {
    method: 'PUT',
    path: ['api', 'areas', ':id'],
    kind: 'session-csrf',
    status: 200,
  },
  'areas.deactivate': {
    method: 'POST',
    path: ['api', 'areas', ':id', 'deactivate'],
    kind: 'session-csrf',
    status: 200,
  },
  'areas.activate': {
    method: 'POST',
    path: ['api', 'areas', ':id', 'activate'],
    kind: 'session-csrf',
    status: 200,
  },
  'areas.history': {
    method: 'GET',
    path: ['api', 'areas', ':id', 'history'],
    kind: 'session',
    status: 200,
  },
} as const satisfies Record<BffRouteId, BffRouteDefinition>;

type Parts<K extends BffRouteId> = Omit<BffRouteTypes[K], 'response'>;

/** What a caller supplies for route `K`: path params, query and body, as the route declares them. */
export type BffCallInput<K extends BffRouteId> = { [P in keyof Parts<K>]: Parts<K>[P] };
export type BffCallArgs<K extends BffRouteId> =
  {} extends BffCallInput<K> ? [input?: BffCallInput<K>] : [input: BffCallInput<K>];
export type BffResponseOf<K extends BffRouteId> = BffRouteTypes[K]['response'];

export const bffRouteIds = Object.keys(BFF_ROUTES) as BffRouteId[];

/** Path of a route with its parameters encoded (and its query string, when given). */
export function bffPath(
  id: BffRouteId,
  params: Readonly<Record<string, string>> = {},
  query: Readonly<Record<string, string | number | undefined>> = {},
): string {
  const path = BFF_ROUTES[id].path
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      const value = params[segment.slice(1)];
      if (value === undefined || value === '') throw new Error(`Missing path parameter ${segment}`);
      return encodeURIComponent(value);
    })
    .join('/');
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) search.set(key, String(value));
  const text = search.toString();
  return `/${path}${text ? `?${text}` : ''}`;
}
