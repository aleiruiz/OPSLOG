import { EntitySchema } from 'typeorm';

export const INCIDENT_REPAIR_TABLES = {
  links: 'opslog_incident_repair_links',
} as const;

const bin = 'utf8mb4_0900_bin';
const text = (name: string, length: number) => ({
  name,
  type: 'varchar' as const,
  length: String(length),
  collation: bin,
  nullable: false,
});

export class IncidentRepairLinkEntity {
  tenantId!: string;
  incidentId!: string;
  id!: string;
  orderId!: string;
  linkedAt!: Date;
  linkedBy!: string;
}

/** The reference from a case to an order of the workshop: no amount is copied here (BR-020). */
export const IncidentRepairLinkSchema = new EntitySchema<IncidentRepairLinkEntity>({
  name: 'IncidentRepairLinkEntity',
  target: IncidentRepairLinkEntity,
  tableName: INCIDENT_REPAIR_TABLES.links,
  columns: {
    tenantId: { ...text('company_id', 64), primary: true },
    incidentId: { ...text('incident_id', 64), primary: true },
    id: { ...text('id', 64), primary: true },
    orderId: text('order_id', 64),
    linkedAt: { name: 'linked_at', type: 'datetime', precision: 6 },
    linkedBy: text('linked_by', 72),
  },
});

export const INCIDENT_REPAIR_ENTITIES = [IncidentRepairLinkSchema];
