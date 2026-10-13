import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import type { Incident } from '../../../../domain/incidents/cases/src/index.js';
import {
  createIncidentDataSource,
  createIncidentMigrationDataSource,
  runIncidentMigrations,
} from './data-source.js';
import { INCIDENT_ENTITIES, INCIDENT_TABLES } from './entities.js';
import {
  idempotencyFrom,
  idempotencyRow,
  incidentFrom,
  incidentRow,
  transitionFrom,
  transitionRow,
} from './mapping.js';
import { CreateIncidentCases2026101500010 } from './migrations.js';
import { TypeOrmIncidentStore } from './store.js';

const endpoint = { host: '127.0.0.1', port: 3306, database: 'opslog_t_x', password: 'x' };
const TENANT = 'tenant-a';

const FULL: Incident = {
  id: 'incident-1',
  tenantId: TENANT,
  folio: 'SIN-2026-000001',
  status: 'repair',
  version: 4,
  cycle: 2,
  reopenCount: 1,
  type: 'collision',
  severity: 'high',
  vehicleId: 'vehicle-1',
  areaId: 'area-1',
  driverId: 'driver-1',
  noDriverReason: null,
  occurredAt: '2026-10-12T15:30:00.123Z',
  occurredOn: '2026-10-12',
  location: { text: 'Av. Reforma', latitude: 19.432608, longitude: -99.133208 },
  description: 'Golpe',
  vehicleOperable: false,
  damage: { description: 'Salpicadera', zones: ['front', 'left_side'] },
  noPhotoJustification: null,
  coverageStatus: 'covered',
  policySnapshot: {
    policyId: 'policy-1',
    revision: 2,
    insurer: 'Aseguradora',
    policyNumber: 'POL-1',
    coverageType: 'comprehensive',
    startsOn: '2026-01-01',
    endsOn: '2026-12-31',
  },
  reportedAt: '2026-10-12T16:00:00.000Z',
  reportedBy: 'user-1',
  responsibleId: 'user-2',
  insurerName: 'Aseguradora',
  claimNumber: 'R-1',
  adjusterName: 'Ajustador',
  adjusterContact: 'contacto',
  insurerReportedOn: '2026-10-12',
  insurerResult: 'accepted',
  rejectionReason: null,
  appealNote: null,
  noInsuranceReason: null,
  costAssumed: false,
  resolutionSummary: 'Reparado',
  totalLoss: false,
  vehicleStatusDecision: 'active',
  resolvedAt: '2026-10-13T10:00:00.000Z',
  assumptionApproval: { by: 'user-3', at: '2026-10-12T17:00:00.000Z' },
  closeApproval: { by: 'user-3', at: '2026-10-13T11:00:00.000Z' },
  closedAt: '2026-10-13T12:00:00.000Z',
  closedBy: 'user-3',
  cancelReason: null,
  createdAt: '2026-10-12T16:00:00.000Z',
  createdBy: 'user-1',
  updatedAt: '2026-10-13T12:00:00.000Z',
  updatedBy: 'user-3',
};
const DRAFT: Incident = {
  ...FULL,
  status: 'draft',
  severity: null,
  driverId: null,
  noDriverReason: 'Sin conductor',
  occurredAt: null,
  occurredOn: null,
  location: null,
  vehicleOperable: null,
  damage: { description: null, zones: [] },
  coverageStatus: 'unknown',
  policySnapshot: null,
  reportedAt: null,
  reportedBy: null,
  responsibleId: null,
  insurerResult: null,
  costAssumed: null,
  totalLoss: null,
  assumptionApproval: null,
  closeApproval: null,
  closedAt: null,
  closedBy: null,
};

function recorder() {
  const statements: string[] = [];
  const runner = {
    query: async (sql: string) => void statements.push(sql),
    dropTable: async (name: string) => void statements.push(`DROP ${name}`),
  } as unknown as QueryRunner;
  return { statements, runner };
}

describe('incident schema', () => {
  it('keys every table by tenant, without cross-module foreign keys, and reverts them in order', async () => {
    const { statements, runner } = recorder();
    const migration = new CreateIncidentCases2026101500010();
    await migration.up(runner);
    expect(statements).toHaveLength(Object.keys(INCIDENT_TABLES).length);
    for (const sql of statements) {
      expect(sql).toMatch(/PRIMARY KEY \(company_id,/);
      expect(sql).toContain('ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin');
    }
    const [incidents, folios, transitions, idempotency] = statements as [
      string,
      string,
      string,
      string,
    ];
    expect(incidents).toContain('PRIMARY KEY (company_id,id)');
    expect(incidents).toContain('UNIQUE KEY uq_incident_folio (company_id,folio)');
    expect(incidents).toContain("status IN ('draft','reported'");
    expect(incidents).toContain("type IN ('collision'");
    expect(folios).toContain('PRIMARY KEY (company_id,year,kind)');
    expect(transitions).toContain('PRIMARY KEY (company_id,incident_id,sequence)');
    expect(idempotency).toContain('PRIMARY KEY (company_id,actor_id,command,idempotency_key)');
    // Only the timeline and the registry point at the incident; nothing points at another module.
    expect(statements.join(' ').match(/FOREIGN KEY/g)).toHaveLength(2);
    expect(statements.join(' ')).not.toMatch(
      /REFERENCES `opslog_(vehicles|employees|insurance|maintenance)/,
    );
    await migration.down(runner);
    expect(statements.slice(-4)).toEqual([
      `DROP ${INCIDENT_TABLES.idempotency}`,
      `DROP ${INCIDENT_TABLES.transitions}`,
      `DROP ${INCIDENT_TABLES.folios}`,
      `DROP ${INCIDENT_TABLES.incidents}`,
    ]);
    expect(INCIDENT_ENTITIES).toHaveLength(Object.keys(INCIDENT_TABLES).length);
  });

  it('carries every column of the aggregate, including those later packages write', () => {
    const row = incidentRow(FULL);
    const columns = INCIDENT_ENTITIES[0].options.columns;
    expect(Object.keys(columns).sort()).toEqual(Object.keys(row).sort());
    for (const group of [
      'responsibleId',
      'insurerName',
      'claimNumber',
      'resolutionSummary',
      'closeApprovedBy',
      'cancelReason',
      'reportedAt',
    ])
      expect(columns).toHaveProperty(group);
  });

  it('maps a complete and a minimal incident without loss', () => {
    for (const incident of [FULL, DRAFT]) {
      const row = incidentRow(incident);
      expect(incidentFrom(row)).toEqual(incident);
      // DECIMAL comes back as text, JSON as parsed or as text, booleans as 0/1.
      expect(
        incidentFrom({
          ...row,
          damageZones: JSON.stringify(row.damageZones) as unknown as object,
          policySnapshot: row.policySnapshot ? (JSON.stringify(row.policySnapshot) as never) : null,
          vehicleOperable:
            row.vehicleOperable === null ? null : (Number(row.vehicleOperable) as never),
          costAssumed: row.costAssumed === null ? null : (Number(row.costAssumed) as never),
          totalLoss: row.totalLoss === null ? null : (Number(row.totalLoss) as never),
        }),
      ).toEqual(incident);
    }
    expect(incidentRow(FULL).locationLatitude).toBe('19.432608');
  });

  it('maps timeline rows and idempotency records without loss', () => {
    const entry = {
      command: 'update',
      from: 'draft' as const,
      to: 'draft' as const,
      actorId: 'user-1',
      comment: null,
      occurredAt: '2026-10-12T16:00:00.123Z',
      changedFields: ['severity', 'type'],
      before: { severity: null, vehicleOperable: true, policyRevision: 2 },
    };
    const row = transitionRow(TENANT, 'incident-1', 3, entry);
    const transition = { ...entry, tenantId: TENANT, incidentId: 'incident-1', sequence: 3 };
    expect(transitionFrom(row)).toEqual(transition);
    expect(
      transitionFrom({
        ...row,
        changedFields: JSON.stringify(entry.changedFields) as unknown as object,
        before: JSON.stringify(entry.before) as unknown as object,
      }),
    ).toEqual(transition);
    expect(
      transitionFrom(transitionRow(TENANT, 'incident-1', 1, { ...entry, before: null })).before,
    ).toBeNull();

    const claim = {
      actorId: 'user-1',
      command: 'create',
      key: 'create-key-0001',
      incidentId: 'incident-1',
      payloadHash: 'a'.repeat(64),
      createdAt: '2026-10-12T12:00:00.123Z',
      expiresAt: '2026-10-13T12:00:00.123Z',
    };
    const stored = idempotencyRow(TENANT, claim, FULL);
    const record = { ...claim, tenantId: TENANT, status: 'completed', response: FULL };
    expect(idempotencyFrom(stored)).toEqual(record);
    expect(
      idempotencyFrom({ ...stored, response: JSON.stringify(FULL) as unknown as object }),
    ).toEqual(record);
  });

  it('only runs with the restricted incidents account and never synchronizes', async () => {
    expect(() => createIncidentDataSource({ ...endpoint, username: 'root' })).toThrow();
    expect(() =>
      createIncidentDataSource({ ...endpoint, username: 'opslog_maintenance_abc' }),
    ).toThrow();
    const source = createIncidentDataSource({ ...endpoint, username: 'opslog_incidents_abc' });
    expect(source.options).toMatchObject({ synchronize: false, migrationsRun: false });
    expect(() => new TypeOrmIncidentStore(source)).not.toThrow();
    const migrator = createIncidentMigrationDataSource({ ...endpoint, username: 'owner' });
    expect(() => new TypeOrmIncidentStore(migrator)).toThrow();
    await expect(
      runIncidentMigrations({ options: { synchronize: true } } as never),
    ).rejects.toThrow('forbidden');
  });
});
