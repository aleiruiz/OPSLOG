/**
 * What the reports read of the owning modules. Each method names the tenant, returns only what the
 * reports need and never returns a value the reader may not see: personal data comes through
 * `personPii` and only when a selected column asks for it; money comes with `withDeductible`.
 */
export interface VehicleFact {
  readonly id: string;
  readonly economicNumber: string;
  readonly plate: string;
  readonly vin: string | null;
  readonly make: string;
  readonly model: string;
  readonly year: number;
  readonly areaId: string;
  readonly status: string;
  readonly statusReason: string;
  readonly odometerKm: number;
  readonly registeredOn: string;
}

export interface PersonFact {
  readonly id: string;
  readonly kind: 'driver' | 'dispatcher' | 'other';
  readonly firstName: string;
  readonly lastName: string;
  readonly employeeNumber: string | null;
  readonly position: string | null;
  readonly hireDate: string | null;
  readonly areaId: string;
  readonly status: string;
  readonly licenseType: string | null;
  readonly licenseExpiresOn: string | null;
}

export interface AreaFact {
  readonly id: string;
  readonly name: string;
  readonly code: string | null;
  readonly parentId: string | null;
  readonly active: boolean;
  readonly responsibleCount: number;
}

/** A current assignment of a vehicle to a driver. */
export interface AssignmentFact {
  readonly vehicleId: string;
  readonly employeeId: string;
  readonly type: 'principal' | 'secondary' | 'temporary';
}

export interface DocumentFact {
  readonly id: string;
  readonly ownerType: 'vehicle' | 'employee';
  readonly ownerId: string;
  readonly typeCode: string;
  readonly documentNumber: string | null;
  readonly issuedOn: string | null;
  readonly expiresOn: string | null;
}

export type DeductibleFact =
  | { readonly kind: 'amount'; readonly amountMinor: number; readonly currency: string }
  | { readonly kind: 'percent'; readonly basisPoints: number };

export interface PolicyFact {
  readonly id: string;
  readonly vehicleId: string;
  readonly insurer: string;
  readonly policyNumber: string;
  readonly coverageType: string;
  readonly startsOn: string;
  readonly endsOn: string;
  /** Present only when the read asked for it (`view_costs`). */
  readonly deductible?: DeductibleFact | null;
}

export type PiiField = 'licenseNumber' | 'phone' | 'email';
export type PiiValues = Readonly<Partial<Record<PiiField, string | null>>>;

export interface ReportSources {
  /** Vehicles that are not archived. */
  vehicles(tenantId: string): Promise<readonly VehicleFact[]>;
  /** People of one kind that are not archived. */
  people(tenantId: string, kind: PersonFact['kind']): Promise<readonly PersonFact[]>;
  /** Every area, active or not. */
  areas(tenantId: string): Promise<readonly AreaFact[]>;
  /** The current assignments of the company. */
  assignments(tenantId: string): Promise<readonly AssignmentFact[]>;
  /** Documents of one owner type that are not archived. */
  documents(
    tenantId: string,
    ownerType: DocumentFact['ownerType'],
  ): Promise<readonly DocumentFact[]>;
  /** Policies that are not archived; the deductible only with `withDeductible`. */
  policies(tenantId: string, withDeductible: boolean): Promise<readonly PolicyFact[]>;
  /** Instant (ISO) of the last status change of each vehicle. */
  statusSince(
    tenantId: string,
    vehicleIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  /** Unsealed personal data of people, for the requested fields only. */
  personPii(
    tenantId: string,
    personIds: readonly string[],
    fields: readonly PiiField[],
  ): Promise<ReadonlyMap<string, PiiValues>>;
}

/** Most rows a report loads: beyond it the report asks for narrower filters instead of exhausting memory. */
export const MAX_REPORT_ROWS = 50_000;
