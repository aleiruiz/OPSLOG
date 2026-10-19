import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { QueryRunner } from 'typeorm';
import type {
  EvidenceRecord,
  ThirdPartyRecord,
} from '../../../../domain/incidents/third-parties/src/index.js';
import { createIncidentDataSource } from '../../cases/src/data-source.js';
import {
  AddIncidentAnalyticsIndexes2026101900010,
  CreateIncidentCases2026101500010,
} from '../../cases/src/migrations.js';
import { INCIDENT_TABLES } from '../../cases/src/entities.js';
import {
  EvidenceSchema,
  INCIDENT_CHILD_ENTITIES,
  INCIDENT_CHILD_TABLES,
  SEALED_LENGTH,
  ThirdPartySchema,
} from './entities.js';
import { evidenceFrom, evidenceRow, thirdPartyFrom, thirdPartyRow } from './mapping.js';
import {
  CreateIncidentChildren2026101500020,
  INCIDENT_CHILDREN_MIGRATION_VERSION,
  INCIDENT_SEALED_WIDENING_VERSION,
  WidenIncidentSealedColumns2026101500030,
} from './migrations.js';
import { TypeOrmIncidentChildStore } from './store.js';

const SEALED = 'pii1.a.b.c.d';
const PARTY: ThirdPartyRecord = {
  id: 'party-1',
  tenantId: 'tenant-a',
  incidentId: 'incident-1',
  kind: 'person',
  identity: { name: SEALED, contact: null, plates: SEALED, policyNumber: null },
  insurerName: 'Aseguradora',
  damageDescription: 'Golpe',
  injuries: true,
  removedAt: '2026-10-13T20:00:00.123Z',
  createdAt: '2026-10-13T18:00:00.123Z',
  createdBy: 'user-1',
  updatedAt: '2026-10-13T19:00:00.123Z',
  updatedBy: 'user-2',
};
const EVIDENCE: EvidenceRecord = {
  id: 'evidence-1',
  tenantId: 'tenant-a',
  incidentId: 'incident-1',
  fileId: 'file-1',
  category: 'photo',
  stage: 'on_site',
  capturedAt: '2026-10-13T17:00:00.000Z',
  clientCompressed: true,
  displayName: 'foto.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 2_000_000,
  attachedBy: 'user-1',
  attachedAt: '2026-10-13T18:00:00.123Z',
};
const endpoint = { host: '127.0.0.1', port: 3306, database: 'opslog_t_x', password: 'x' };

describe('incident children schema (migration after the cases)', () => {
  it('creates the two tables with the keys, checks and no cross-module foreign key', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => void statements.push(sql),
      dropTable: async (name: string) => void statements.push(`DROP ${name}`),
    } as unknown as QueryRunner;
    const migration = new CreateIncidentChildren2026101500020();
    await migration.up(runner);
    const [parties, evidence] = statements as [string, string];
    expect(statements).toHaveLength(2);
    expect(parties).toContain('PRIMARY KEY (company_id,incident_id,id)');
    expect(parties).toContain("kind IN ('person','vehicle','property')");
    for (const column of ['name_enc', 'contact_enc', 'plates_enc', 'policy_number_enc'])
      expect(parties).toContain(`${column} IS NULL OR ${column} LIKE 'pii1.%'`);
    expect(evidence).toContain('PRIMARY KEY (company_id,incident_id,id)');
    expect(evidence).toContain('UNIQUE KEY uq_incident_evidence_file (company_id,file_id)');
    expect(evidence).toContain("category IN ('photo','police_report'");
    expect(evidence).toContain("stage IN ('on_site','workshop','post_repair','other')");
    // Only the incident is referenced; vehicles, files and members are validated through ports.
    expect(statements.join(' ').match(/REFERENCES `([a-z_]+)`/g)).toEqual([
      `REFERENCES \`${INCIDENT_TABLES.incidents}\``,
      `REFERENCES \`${INCIDENT_TABLES.incidents}\``,
    ]);
    for (const sql of statements) expect(sql).toContain('COLLATE=utf8mb4_0900_bin');
    await migration.down(runner);
    expect(statements.slice(-2)).toEqual([
      `DROP ${INCIDENT_CHILD_TABLES.evidence}`,
      `DROP ${INCIDENT_CHILD_TABLES.thirdParties}`,
    ]);
    expect(INCIDENT_CHILD_ENTITIES).toHaveLength(Object.keys(INCIDENT_CHILD_TABLES).length);
    expect(INCIDENT_CHILDREN_MIGRATION_VERSION).toBe('2026101500020');
  });

  it('widens the sealed columns in a later migration, leaving the first one at its original size', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => void statements.push(sql),
    } as unknown as QueryRunner;
    const first = new CreateIncidentChildren2026101500020();
    await first.up({ query: async (sql: string) => void statements.push(sql) } as QueryRunner);
    expect(statements[0]).toContain('name_enc VARCHAR(1024)');
    statements.length = 0;
    const widen = new WidenIncidentSealedColumns2026101500030();
    await widen.up(runner);
    await widen.down(runner);
    expect(SEALED_LENGTH).toBe(2048);
    expect(INCIDENT_SEALED_WIDENING_VERSION).toBe('2026101500030');
    for (const column of ['name_enc', 'contact_enc', 'plates_enc', 'policy_number_enc']) {
      expect(statements[0]).toContain(`MODIFY ${column} VARCHAR(2048)`);
      expect(statements[1]).toContain(`MODIFY ${column} VARCHAR(1024)`);
    }
    // 200 four-byte characters through the worst realistic envelope still fit.
    const body = Math.ceil(((200 * 4 + 16) * 4) / 3);
    const overhead = 'pii1.'.length + 171 + 1 + 400 + 1 + 16 + 1;
    expect(body + overhead).toBeLessThan(SEALED_LENGTH);
  });

  it('registers the entities and the migration after the cases one in the incidents data source', () => {
    const source = createIncidentDataSource({ ...endpoint, username: 'opslog_incidents_abc' });
    expect(source.options.migrations).toEqual([
      CreateIncidentCases2026101500010,
      CreateIncidentChildren2026101500020,
      WidenIncidentSealedColumns2026101500030,
      AddIncidentAnalyticsIndexes2026101900010,
    ]);
    expect(source.options.entities).toEqual(
      expect.arrayContaining([ThirdPartySchema, EvidenceSchema]),
    );
  });

  it('maps rows without loss, with booleans as 0/1 and sealed columns untouched', () => {
    expect(thirdPartyFrom(thirdPartyRow(PARTY))).toEqual(PARTY);
    expect(thirdPartyFrom({ ...thirdPartyRow(PARTY), injuries: 1 }).injuries).toBe(true);
    const live = { ...PARTY, removedAt: null, injuries: false };
    expect(thirdPartyFrom({ ...thirdPartyRow(live), injuries: 0 })).toEqual(live);
    expect(evidenceFrom(evidenceRow(EVIDENCE))).toEqual(EVIDENCE);
    const bare = { ...EVIDENCE, capturedAt: null, clientCompressed: false };
    expect(evidenceFrom({ ...evidenceRow(bare), clientCompressed: 0 })).toEqual(bare);
    expect(Object.keys(ThirdPartySchema.options.columns).sort()).toEqual(
      Object.keys(thirdPartyRow(PARTY)).sort(),
    );
    expect(Object.keys(EvidenceSchema.options.columns).sort()).toEqual(
      Object.keys(evidenceRow(EVIDENCE)).sort(),
    );
  });

  it('joins the transaction of the incident store and refuses plaintext identity', async () => {
    const inserted: unknown[] = [];
    let live = 0;
    const manager = {
      getRepository: () => ({
        countBy: async () => live,
        insert: async (row: unknown) => void inserted.push(row),
        update: async () => ({ affected: 0 }),
        delete: async () => ({ affected: 0 }),
      }),
    };
    let transaction: unknown;
    const base = {
      apply: async (_mutation: unknown, extra: { run(tx: unknown): Promise<boolean> }) => {
        transaction = await extra.run(manager);
        return { applied: transaction === true };
      },
    };
    const source = createIncidentDataSource({ ...endpoint, username: 'opslog_incidents_abc' });
    const store = new TypeOrmIncidentChildStore(source, base as never);
    const mutation = {} as never;
    expect(await store.apply(mutation, { kind: 'third_party_add', party: PARTY })).toEqual({
      applied: true,
    });
    expect(await store.apply(mutation, { kind: 'evidence_attach', evidence: EVIDENCE })).toEqual({
      applied: true,
    });
    expect(inserted).toHaveLength(2);
    // An update or a detach that matches no row refuses the whole mutation.
    expect(await store.apply(mutation, { kind: 'third_party_update', party: PARTY })).toEqual({
      applied: false,
    });
    expect(
      await store.apply(mutation, {
        kind: 'evidence_detach',
        tenantId: 't',
        incidentId: 'i',
        evidenceId: 'e',
      }),
    ).toEqual({ applied: false });
    const plain = { ...PARTY, identity: { ...PARTY.identity, name: 'Marta Sintética' } };
    await expect(store.apply(mutation, { kind: 'third_party_add', party: plain })).rejects.toThrow(
      'must be sealed',
    );
    await expect(
      store.apply(mutation, { kind: 'third_party_update', party: plain }),
    ).rejects.toThrow('must be sealed');
    // The caps are counted again inside the transaction, after the case row was locked.
    live = 20;
    await expect(
      store.apply(mutation, { kind: 'third_party_add', party: PARTY }),
    ).rejects.toMatchObject({ code: 'rule_violation' });
    live = 50;
    await expect(
      store.apply(mutation, { kind: 'evidence_attach', evidence: EVIDENCE }),
    ).rejects.toMatchObject({ code: 'rule_violation' });
    live = 19;
    expect(await store.apply(mutation, { kind: 'third_party_add', party: PARTY })).toEqual({
      applied: true,
    });
    const migrator = createIncidentDataSource({ ...endpoint, username: 'opslog_incidents_abc' });
    (migrator.options as { synchronize: boolean }).synchronize = true;
    expect(() => new TypeOrmIncidentChildStore(migrator, base as never)).toThrow();
  });
});
