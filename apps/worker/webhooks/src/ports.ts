export interface VehicleFacts {
  readonly economicNumber: string;
  readonly status: string;
}
export interface IncidentFacts {
  readonly folio: string;
  readonly vehicleId: string;
}
export interface OrderFacts {
  readonly status: string;
  readonly vehicleId: string;
}

/**
 * Where the handlers read the facts of an event: the modules' own ports, wired by the composition.
 * Every method names the company and answers null for a record it cannot see.
 */
export interface WebhookSources {
  vehicle(tenantId: string, vehicleId: string): Promise<VehicleFacts | null>;
  incident(tenantId: string, incidentId: string): Promise<IncidentFacts | null>;
  order(tenantId: string, orderId: string): Promise<OrderFacts | null>;
}
