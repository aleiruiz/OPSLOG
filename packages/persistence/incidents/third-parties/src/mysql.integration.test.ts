import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import {
  IncidentService,
  type IncidentActor,
  type IncidentReferences,
} from '../../../../domain/incidents/cases/src/index.js';
import {
  EvidenceService,
  IdentityVault,
  ThirdPartyService,
  type FileLifecycle,
  type FileRecordRef,
  type IncidentFiles,
} from '../../../../domain/incidents/third-parties/src/index.js';
import { EnvelopePiiCipher, LocalDevKms } from '../../../../platform/pii/src/index.js';
import { AUDIT_TABLES } from '../../../audit/src/index.js';
import { INCIDENT_TABLES } from '../../cases/src/entities.js';
import { TypeOrmIncidentStore } from '../../cases/src/store.js';
import {
  adminUrl,
  startIncidentDatabase,
  type IncidentTestDatabase,
} from '../../cases/src/test-support/mysql.js';
import { INCIDENT_CHILD_TABLES as T } from './entities.js';
import { TypeOrmIncidentChildStore } from './store.js';

const suite = adminUrl ? describe : describe.skip;
const actor = (permissions: string[]): IncidentActor => {
  const subject = randomUUID();
  return { id: `user-${subject}`, subject, permissions, mechanicLinked: false };
};
const MANAGER = actor(['view', 'incidents:view', 'incidents:create', 'incidents:edit', 'view_pii']);
const NO_PII = actor(['incidents:view', 'incidents:edit']);
const VIEWER = actor(['incidents:view', 'view_pii']);
const draft = { vehicleId: 'vehicle-1', type: 'collision' };
const PARTY = {
  kind: 'person',
  name: 'Marta Sintética Ruiz',
  contact: '+52 55 0000 1234',
  plates: 'ZZZ-999-X',
  policyNumber: 'POL-TERCERO-77',
  insurerName: 'Aseguradora Tercera',
  damageDescription: 'Golpe en puerta izquierda',
  injuries: true,
};
const SECRETS = [PARTY.name, PARTY.contact, PARTY.plates, PARTY.policyNumber];
const meta = { category: 'photo', stage: 'on_site' } as const;
/** Each attempt starts only when it is awaited, so a rejection is never left unhandled. */
const refuses = async (code: string, attempts: readonly (() => Promise<unknown>)[]) => {
  for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject({ code });
};

const refs: IncidentReferences = {
  vehicle: async (_tenant, id) =>
    id === 'vehicle-1' ? { id, areaId: 'area-1', registeredOn: '2026-01-01' } : null,
  driver: async () => null,
  assignments: async () => [],
  policyRevisions: async () => [],
  timeZone: async () => 'UTC',
};

/** A files module stand-in keyed by tenant: real ids, a controllable lifecycle. */
class Files implements IncidentFiles {
  public readonly records = new Map<string, FileRecordRef>();
  public async record(tenantId: string, fileId: string) {
    return this.records.get(`${tenantId}/${fileId}`) ?? null;
  }
  public add(tenantId: string, owner: string, status: FileLifecycle = 'pending_scan') {
    const id = `file-${randomUUID()}`;
    this.records.set(`${tenantId}/${id}`, {
      id,
      status,
      kind: 'original',
      sensitivity: 'standard',
      createdBy: owner,
      displayName: 'foto.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 2_000_000,
    });
    return id;
  }
  public async ingest(tenantId: string, owner: string) {
    return { id: this.add(tenantId, owner) };
  }
}

suite('incident third parties and evidence on disposable MySQL 8.4', () => {
  let db: IncidentTestDatabase;
  let sourceA: DataSource;
  let sourceA2: DataSource;
  let sourceB: DataSource;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const now = new Date('2026-10-13T18:00:00.000Z');
  const cipher = new EnvelopePiiCipher(LocalDevKms.ephemeral('test'));
  const files = new Files();
  const world = (source: DataSource, sealing: EnvelopePiiCipher = cipher) => {
    const store = new TypeOrmIncidentStore(source);
    const children = new TypeOrmIncidentChildStore(source, store);
    const options = { now: () => now };
    return {
      store,
      children,
      incidents: new IncidentService(store, refs, options),
      parties: new ThirdPartyService(store, children, new IdentityVault(sealing), options),
      evidence: new EvidenceService(store, children, files, options),
    };
  };
  const count = async (table: string, tenantColumn: string, tenant: string, extra = '1=1') => {
    const [row] = await db.rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${table} WHERE ${tenantColumn}=? AND ${extra}`,
      [tenant],
    );
    return Number(row?.n);
  };
  const snapshot = async (incidentId: string) => ({
    parties: await count(T.thirdParties, 'company_id', tenantA, `incident_id='${incidentId}'`),
    evidence: await count(T.evidence, 'company_id', tenantA, `incident_id='${incidentId}'`),
    transitions: await count(
      INCIDENT_TABLES.transitions,
      'company_id',
      tenantA,
      `incident_id='${incidentId}'`,
    ),
    audit: await count(AUDIT_TABLES.local, 'tenant_id', tenantA, `entity_id='${incidentId}'`),
    outbox: await count(AUDIT_TABLES.outbox, 'tenant_id', tenantA, `entity_id='${incidentId}'`),
    version: (
      await db.rows<{ version: number }>(
        `SELECT version FROM ${INCIDENT_TABLES.incidents} WHERE company_id=? AND id=?`,
        [tenantA, incidentId],
      )
    )[0]?.version,
  });

  beforeAll(async () => {
    db = await startIncidentDatabase('children');
    sourceA = await db.openIncidents('a');
    sourceA2 = await db.openIncidents('a');
    sourceB = await db.openIncidents('b');
  }, 180_000);
  afterAll(async () => {
    await db?.close();
  }, 60_000);

  it('stores only sealed envelopes and keeps every protected value out of audit, outbox and timeline', async () => {
    const w = world(sourceA);
    const incident = await w.incidents.create(tenantA, MANAGER, draft);
    const created = await w.parties.create(tenantA, MANAGER, incident.id, {
      version: 1,
      ...PARTY,
    });
    expect(created.incident.version).toBe(2);
    const [row] = await db.rows<Record<string, string | number | null>>(
      `SELECT * FROM ${T.thirdParties} WHERE company_id=? AND id=?`,
      [tenantA, created.party.id],
    );
    for (const column of ['name_enc', 'contact_enc', 'plates_enc', 'policy_number_enc'])
      expect(row?.[column], column).toMatch(/^pii1\./);
    expect(row).toMatchObject({ kind: 'person', injuries: 1, removed_at: null });
    const dump = JSON.stringify([
      await db.rows(`SELECT * FROM ${T.thirdParties}`),
      await db.rows(`SELECT * FROM ${INCIDENT_TABLES.transitions}`),
      await db.rows(`SELECT * FROM ${AUDIT_TABLES.local}`),
      await db.rows(`SELECT * FROM ${AUDIT_TABLES.outbox}`),
    ]);
    for (const secret of SECRETS) expect(dump).not.toContain(secret);

    const exact = await world(sourceA2).parties.list(tenantA, MANAGER, incident.id);
    expect(exact[0]).toMatchObject({
      identityRestricted: false,
      name: PARTY.name,
      contact: PARTY.contact,
      plates: PARTY.plates,
      policyNumber: PARTY.policyNumber,
    });
    const hidden = await w.parties.list(tenantA, NO_PII, incident.id);
    expect(hidden[0]).toMatchObject({ identityRestricted: true });
    expect(JSON.stringify(hidden)).not.toMatch(/Marta|0000 1234|ZZZ-999|POL-TERCERO/);

    const outbox = await db.rows<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM ${AUDIT_TABLES.outbox} WHERE tenant_id=? AND entity_id=?`,
      [tenantA, incident.id],
    );
    expect(outbox.map((r) => Object.keys(r.payload).sort().join()).sort()).toEqual([
      'incidentId,vehicleId,version',
      'incidentId,version',
    ]);
    const timeline = await w.store.history(tenantA, incident.id);
    expect(timeline.at(-1)).toMatchObject({
      command: 'third_party_added',
      changedFields: expect.arrayContaining(['name', 'plates']),
    });
  });

  it('stores the longest identity: 200 three-byte characters under a long key id seal past the first 1,024 characters', async () => {
    const arn = `synthetic.key.${randomUUID()}.${'k'.repeat(70)}`;
    const real = new EnvelopePiiCipher(
      new LocalDevKms({ masterKey: randomBytes(32), environment: 'test', keyId: arn }),
    );
    const w = world(sourceA, real);
    const incident = await w.incidents.create(tenantA, MANAGER, draft);
    const contact = '\u6F22'.repeat(200);
    const created = await w.parties.create(tenantA, MANAGER, incident.id, {
      version: 1,
      kind: 'person',
      contact,
    });
    const [row] = await db.rows<{ contact_enc: string }>(
      `SELECT contact_enc FROM ${T.thirdParties} WHERE company_id=? AND id=?`,
      [tenantA, created.party.id],
    );
    expect(row?.contact_enc.length).toBeGreaterThan(1024);
    const [listed] = await w.parties.list(tenantA, MANAGER, incident.id);
    expect(listed?.contact).toBe(contact);
  });

  it('rejects a plaintext identity or a bad enum even from a buggy writer', async () => {
    const w = world(sourceA);
    const incident = await w.incidents.create(tenantA, MANAGER, draft);
    const base = `INSERT INTO ${T.thirdParties} (company_id,incident_id,id,kind,%COLS%injuries,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,%VALS%0,NOW(6),'u',NOW(6),'u')`;
    const run = (cols: string, vals: string, id: string) =>
      db.rows(base.replace('%COLS%', cols).replace('%VALS%', vals), [tenantA, incident.id, id]);
    await run('', "'person',", 'ok-1');
    await expect(run('name_enc,', "'person','Marta Sintética',", 'bad-1')).rejects.toBeDefined();
    await expect(run('plates_enc,', "'person','ZZZ-999',", 'bad-2')).rejects.toBeDefined();
    await expect(run('', "'robot',", 'bad-3')).rejects.toBeDefined();
    await expect(
      db.rows(
        `INSERT INTO ${T.evidence} (company_id,incident_id,id,file_id,category,stage,client_compressed,display_name,content_type,size_bytes,attached_by,attached_at) VALUES (?,?, 'e1','f1','selfie','on_site',0,'a','image/jpeg',1,'u',NOW(6))`,
        [tenantA, incident.id],
      ),
    ).rejects.toBeDefined();
    await expect(
      db.rows(
        `INSERT INTO ${T.thirdParties} (company_id,incident_id,id,kind,injuries,created_at,created_by,updated_at,updated_by) VALUES (?,'missing','x','person',0,NOW(6),'u',NOW(6),'u')`,
        [tenantA],
      ),
    ).rejects.toBeDefined();
  });

  for (const routine of [
    'opslog_enqueue_tenant_outbox',
    'opslog_append_local_audit_and_delivery',
  ]) {
    it(`leaves nothing behind when ${routine} fails (case 13)`, async () => {
      const w = world(sourceA);
      const incident = await w.incidents.create(tenantA, MANAGER, draft);
      const fileId = files.add(tenantA, MANAGER.id);
      const before = await snapshot(incident.id);
      await db.rows(
        `REVOKE EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`${routine}\` FROM '${db.runtimeUserA}'@'%'`,
      );
      try {
        await expect(
          w.parties.create(tenantA, MANAGER, incident.id, { version: 1, ...PARTY }),
        ).rejects.toBeDefined();
        await expect(
          w.evidence.attach(tenantA, MANAGER, incident.id, { version: 1, fileId, ...meta }),
        ).rejects.toBeDefined();
      } finally {
        await db.rows(
          `GRANT EXECUTE ON PROCEDURE \`${db.databaseName}\`.\`${routine}\` TO '${db.runtimeUserA}'@'%'`,
        );
      }
      expect(await snapshot(incident.id)).toEqual(before);
      // Nothing was consumed: the same version and the same file go through once the routine is back.
      const retry = await w.evidence.attach(tenantA, MANAGER, incident.id, {
        version: 1,
        fileId,
        ...meta,
      });
      expect(retry.incident.version).toBe(2);
      expect((await snapshot(incident.id)).evidence).toBe(1);
    });
  }

  it('links a file once per tenant, even when two connections race for it (case 11)', async () => {
    const w = world(sourceA);
    const w2 = world(sourceA2);
    const one = await w.incidents.create(tenantA, MANAGER, draft);
    const two = await w.incidents.create(tenantA, MANAGER, draft);
    const fileId = files.add(tenantA, MANAGER.id);
    const results = await Promise.allSettled([
      w.evidence.attach(tenantA, MANAGER, one.id, { version: 1, fileId, ...meta }),
      w2.evidence.attach(tenantA, MANAGER, two.id, { version: 1, fileId, ...meta }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'duplicate' },
    });
    expect(await count(T.evidence, 'company_id', tenantA, `file_id='${fileId}'`)).toBe(1);
    const loser = results[0]?.status === 'rejected' ? one : two;
    expect(await snapshot(loser.id)).toMatchObject({ evidence: 0, version: 1, transitions: 1 });
    // The database itself refuses a second row for the file.
    await expect(
      db.rows(
        `INSERT INTO ${T.evidence} (company_id,incident_id,id,file_id,category,stage,client_compressed,display_name,content_type,size_bytes,attached_by,attached_at) VALUES (?,?, 'dup','${fileId}','photo','on_site',0,'a','image/jpeg',1,'u',NOW(6))`,
        [tenantA, loser.id],
      ),
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
  });

  it('keeps the original on detach, writes the timeline and lets the file be linked again', async () => {
    const w = world(sourceA);
    const incident = await w.incidents.create(tenantA, MANAGER, draft);
    const fileId = files.add(tenantA, MANAGER.id, 'clean');
    const linked = await w.evidence.attach(tenantA, MANAGER, incident.id, {
      version: 1,
      fileId,
      ...meta,
      clientCompressed: true,
      capturedAt: '2026-10-13T10:00:00Z',
    });
    expect(linked.evidence).toMatchObject({
      fileStatus: 'clean',
      counts: true,
      clientCompressed: true,
    });
    const [row] = await db.rows<Record<string, unknown>>(
      `SELECT client_compressed, size_bytes, captured_at FROM ${T.evidence} WHERE company_id=? AND id=?`,
      [tenantA, linked.evidence.id],
    );
    expect(row).toMatchObject({ client_compressed: 1, size_bytes: 2_000_000 });
    const detached = await w.evidence.detach(tenantA, MANAGER, incident.id, linked.evidence.id, {
      version: 2,
    });
    expect(detached.version).toBe(3);
    expect(await count(T.evidence, 'company_id', tenantA, `file_id='${fileId}'`)).toBe(0);
    expect(files.records.has(`${tenantA}/${fileId}`)).toBe(true);
    expect((await w.store.history(tenantA, incident.id)).map((t) => t.command)).toEqual([
      'create',
      'evidence_attached',
      'evidence_detached',
    ]);
    const again = await w.evidence.attach(tenantA, MANAGER, incident.id, {
      version: 3,
      fileId,
      ...meta,
    });
    expect(again.incident.version).toBe(4);
  });

  it('lets exactly one of two concurrent writes with the same version win', async () => {
    const incident = await world(sourceA).incidents.create(tenantA, MANAGER, draft);
    const results = await Promise.allSettled([
      world(sourceA).parties.create(tenantA, MANAGER, incident.id, { version: 1, ...PARTY }),
      world(sourceA2).parties.create(tenantA, MANAGER, incident.id, {
        version: 1,
        kind: 'vehicle',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'stale_version' },
    });
    expect(await snapshot(incident.id)).toMatchObject({ parties: 1, version: 2, transitions: 2 });
  });

  it('creates one third party per Idempotency-Key across connections and rejects another body', async () => {
    const incident = await world(sourceA).incidents.create(tenantA, MANAGER, draft);
    const body = { version: 1, ...PARTY };
    const [a, b] = await Promise.all([
      world(sourceA).parties.create(tenantA, MANAGER, incident.id, body, 'party-key-0001'),
      world(sourceA2).parties.create(tenantA, MANAGER, incident.id, body, 'party-key-0001'),
    ]);
    expect(b.party.id).toBe(a.party.id);
    expect(await snapshot(incident.id)).toMatchObject({ parties: 1, version: 2 });
    await expect(
      world(sourceA).parties.create(
        tenantA,
        MANAGER,
        incident.id,
        { ...body, name: 'Otra persona' },
        'party-key-0001',
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const bytes = await db.rows<{ payload_hash: string }>(
      `SELECT payload_hash FROM ${INCIDENT_TABLES.idempotency} WHERE company_id=? AND idempotency_key='party-key-0001'`,
      [tenantA],
    );
    expect(bytes).toHaveLength(1);
  });

  it('soft-deletes a third party for good and refuses writes on a closed or cancelled case (case 12)', async () => {
    const w = world(sourceA);
    const incident = await w.incidents.create(tenantA, MANAGER, draft);
    const created = await w.parties.create(tenantA, MANAGER, incident.id, { version: 1, ...PARTY });
    const removedVersion = (
      await w.parties.remove(tenantA, MANAGER, incident.id, created.party.id, { version: 2 })
    ).version;
    expect(await w.parties.list(tenantA, MANAGER, incident.id)).toEqual([]);
    expect(
      await count(
        T.thirdParties,
        'company_id',
        tenantA,
        `id='${created.party.id}' AND removed_at IS NOT NULL`,
      ),
    ).toBe(1);
    // A late write cannot revive a removed row: the store refuses and rolls back.
    const [stored] = await w.children.thirdParties(tenantA, incident.id, { includeRemoved: true });
    const late = await w.children.apply(
      {
        incident: { ...(await w.store.get(tenantA, incident.id))!, version: removedVersion + 1 },
        expectedVersion: removedVersion,
        folioYear: null,
        transitions: [],
        auditActions: [],
        events: [],
      },
      { kind: 'third_party_update', party: { ...stored!, removedAt: null } },
    );
    expect(late).toEqual({ applied: false });
    expect((await w.store.get(tenantA, incident.id))?.version).toBe(removedVersion);

    for (const status of ['closed', 'cancelled'] as const) {
      const locked = await w.incidents.create(tenantA, MANAGER, draft);
      const party = await w.parties.create(tenantA, MANAGER, locked.id, { version: 1, ...PARTY });
      const fileId = files.add(tenantA, MANAGER.id);
      await db.rows(
        `UPDATE ${INCIDENT_TABLES.incidents} SET status=?, cancel_reason='fixture' WHERE company_id=? AND id=?`,
        [status, tenantA, locked.id],
      );
      const before = await snapshot(locked.id);
      await refuses('invalid_transition', [
        () => w.parties.create(tenantA, MANAGER, locked.id, { version: 2, kind: 'vehicle' }),
        () =>
          w.parties.update(tenantA, MANAGER, locked.id, party.party.id, {
            version: 2,
            injuries: false,
          }),
        () => w.parties.remove(tenantA, MANAGER, locked.id, party.party.id, { version: 2 }),
        () => w.evidence.attach(tenantA, MANAGER, locked.id, { version: 2, fileId, ...meta }),
        () =>
          w.evidence.upload(
            tenantA,
            MANAGER,
            locked.id,
            { version: 2, name: 'a.jpg', contentType: 'image/jpeg', ...meta },
            new Uint8Array([1]),
            'corr',
          ),
      ]);
      expect(await snapshot(locked.id)).toEqual(before);
    }
  });

  it('isolates tenants by database and by tenant key in both directions (case 7)', async () => {
    const wa = world(sourceA);
    const wb = world(sourceB);
    const inA = await wa.incidents.create(tenantA, MANAGER, draft);
    const inB = await wb.incidents.create(tenantB, MANAGER, draft);
    const partyA = await wa.parties.create(tenantA, MANAGER, inA.id, { version: 1, ...PARTY });
    const fileA = files.add(tenantA, MANAGER.id);
    const evidenceA = await wa.evidence.attach(tenantA, MANAGER, inA.id, {
      version: 2,
      fileId: fileA,
      ...meta,
    });
    const partyB = await wb.parties.create(tenantB, MANAGER, inB.id, { version: 1, ...PARTY });
    // Tenant keys on the right database see nothing of the other tenant.
    expect(await wa.children.thirdParties(tenantB, inA.id)).toEqual([]);
    expect(await wa.children.evidence(tenantB, inA.id)).toEqual([]);
    expect(await wa.children.evidenceOfFile(tenantB, fileA)).toBeNull();
    expect(await wb.children.thirdParties(tenantA, inB.id)).toEqual([]);
    for (const [w, tenant, id, party, link] of [
      [wa, tenantB, inA.id, partyA.party.id, evidenceA.evidence.id],
      [wb, tenantA, inB.id, partyB.party.id, 'whatever'],
    ] as const)
      await refuses('not_found', [
        () => w.parties.list(tenant, MANAGER, id),
        () => w.parties.create(tenant, MANAGER, id, { version: 2, kind: 'vehicle' }),
        () => w.parties.update(tenant, MANAGER, id, party, { version: 2, injuries: false }),
        () => w.parties.remove(tenant, MANAGER, id, party, { version: 2 }),
        () => w.evidence.list(tenant, MANAGER, id),
        () => w.evidence.detach(tenant, MANAGER, id, link, { version: 3 }),
        () => w.evidence.downloadable(tenant, MANAGER, id, link),
      ]);
    expect(await snapshot(inA.id)).toMatchObject({ parties: 1, evidence: 1, version: 3 });
    // The other tenant's physical database is out of reach of the runtime account.
    await expect(
      sourceA.query(`SELECT id FROM \`${db.otherDatabaseName}\`.\`${T.thirdParties}\``),
    ).rejects.toBeDefined();
  });

  it('follows the permission model on real rows (case 16)', async () => {
    const w = world(sourceA);
    const incident = await w.incidents.create(tenantA, MANAGER, draft);
    const created = await w.parties.create(tenantA, MANAGER, incident.id, { version: 1, ...PARTY });
    const fileId = files.add(tenantA, VIEWER.id);
    const generic = actor(['view', 'create', 'edit', 'view_pii']);
    await refuses('forbidden', [
      () => w.parties.list(tenantA, generic, incident.id),
      () => w.evidence.list(tenantA, generic, incident.id),
      () => w.parties.create(tenantA, VIEWER, incident.id, { version: 2, kind: 'vehicle' }),
      () =>
        w.parties.update(tenantA, VIEWER, incident.id, created.party.id, {
          version: 2,
          injuries: false,
        }),
      () => w.parties.remove(tenantA, VIEWER, incident.id, created.party.id, { version: 2 }),
      () => w.evidence.attach(tenantA, VIEWER, incident.id, { version: 2, fileId, ...meta }),
    ]);
    expect(await w.parties.list(tenantA, VIEWER, incident.id)).toHaveLength(1);
    expect(await snapshot(incident.id)).toMatchObject({ parties: 1, evidence: 0, version: 2 });
  });

  it('gives the runtime account exactly the documented grants on the two tables', async () => {
    await expect(sourceA.query(`UPDATE ${T.evidence} SET stage='workshop'`)).rejects.toBeDefined();
    await expect(sourceA.query(`DELETE FROM ${T.thirdParties}`)).rejects.toBeDefined();
    await expect(sourceA.query(`DROP TABLE ${T.evidence}`)).rejects.toBeDefined();
    await expect(
      sourceA.query(`ALTER TABLE ${T.thirdParties} ADD COLUMN evil INT`),
    ).rejects.toBeDefined();
    const grants = (
      await db.rows<Record<string, string>>(`SHOW GRANTS FOR '${db.runtimeUserA}'@'%'`)
    ).map((row) => Object.values(row)[0] as string);
    const on = (table: string) =>
      grants
        .find((line) => line.includes(`\`${db.databaseName}\`.\`${table}\``))
        ?.replace(/^GRANT (.*) ON .*$/, '$1');
    expect(on(T.thirdParties)).toBe('SELECT, INSERT, UPDATE');
    expect(on(T.evidence)).toBe('SELECT, INSERT, DELETE');
  });
});
