import { EntitySchema } from 'typeorm';

export const WEBHOOK_TABLES = {
  endpoints: 'opslog_webhook_endpoints',
  deliveries: 'opslog_webhook_deliveries',
  driverState: 'opslog_webhook_driver_state',
} as const;

export const BINARY_COLLATION = 'utf8mb4_0900_bin';
const text = (name: string, length: number, nullable = false) => ({
  name,
  type: 'varchar' as const,
  length: String(length),
  collation: BINARY_COLLATION,
  nullable,
});
const instant = (name: string, nullable = false) => ({
  name,
  type: 'datetime' as const,
  precision: 6,
  nullable,
});
const flag = (name: string) => ({
  name,
  type: 'tinyint' as const,
  width: 1,
  transformer: {
    to: (value: boolean) => (value ? 1 : 0),
    from: (value: number | boolean) => value === true || value === 1,
  },
});

export class EndpointEntity {
  tenantId!: string;
  id!: string;
  url!: string;
  events!: string[];
  active!: boolean;
  disabledReason!: string | null;
  companyRef!: string;
  secretSealed!: string;
  previousSealed!: string | null;
  previousExpiresAt!: Date | null;
  consecutiveFailures!: number;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
  createdBy!: string;
}
export class DeliveryEntity {
  tenantId!: string;
  id!: string;
  endpointId!: string;
  eventId!: string;
  eventType!: string;
  body!: string;
  status!: string;
  attempts!: number;
  manual!: boolean;
  nextAttemptAt!: Date | null;
  leaseUntil!: Date | null;
  lastAttemptAt!: Date | null;
  lastStatusCode!: number | null;
  lastDurationMs!: number | null;
  lastError!: string | null;
  createdAt!: Date;
  updatedAt!: Date;
}
export class DriverStateEntity {
  tenantId!: string;
  driverId!: string;
  eligible!: boolean;
  transitions!: number;
  updatedAt!: Date;
}

export const EndpointSchema = new EntitySchema<EndpointEntity>({
  name: 'WebhookEndpointEntity',
  target: EndpointEntity,
  tableName: WEBHOOK_TABLES.endpoints,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    id: { ...text('id', 64), primary: true },
    url: text('url', 2048),
    events: { name: 'events', type: 'json' },
    active: flag('active'),
    disabledReason: text('disabled_reason', 24, true),
    companyRef: text('company_ref', 40),
    secretSealed: text('secret_sealed', 1024),
    previousSealed: text('previous_sealed', 1024, true),
    previousExpiresAt: instant('previous_expires_at', true),
    consecutiveFailures: { name: 'consecutive_failures', type: 'int' },
    version: { name: 'version', type: 'int' },
    createdAt: instant('created_at'),
    updatedAt: instant('updated_at'),
    createdBy: text('created_by', 128),
  },
});

export const DeliverySchema = new EntitySchema<DeliveryEntity>({
  name: 'WebhookDeliveryEntity',
  target: DeliveryEntity,
  tableName: WEBHOOK_TABLES.deliveries,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    id: { ...text('id', 64), primary: true },
    endpointId: text('endpoint_id', 64),
    eventId: text('event_id', 64),
    eventType: text('event_type', 32),
    body: { name: 'body', type: 'text' },
    status: text('status', 12),
    attempts: { name: 'attempts', type: 'int' },
    manual: flag('manual'),
    nextAttemptAt: instant('next_attempt_at', true),
    leaseUntil: instant('lease_until', true),
    lastAttemptAt: instant('last_attempt_at', true),
    lastStatusCode: { name: 'last_status_code', type: 'smallint', nullable: true },
    lastDurationMs: { name: 'last_duration_ms', type: 'int', nullable: true },
    lastError: text('last_error', 48, true),
    createdAt: instant('created_at'),
    updatedAt: instant('updated_at'),
  },
});

export const DriverStateSchema = new EntitySchema<DriverStateEntity>({
  name: 'WebhookDriverStateEntity',
  target: DriverStateEntity,
  tableName: WEBHOOK_TABLES.driverState,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    driverId: { ...text('driver_id', 128), primary: true },
    eligible: flag('eligible'),
    transitions: { name: 'transitions', type: 'int' },
    updatedAt: instant('updated_at'),
  },
});

export const WEBHOOK_ENTITIES = [EndpointSchema, DeliverySchema, DriverStateSchema];
