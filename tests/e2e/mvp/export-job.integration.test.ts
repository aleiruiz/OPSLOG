import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BffExport } from '../../../packages/contracts/src/index.js';
import { adminUrl } from '../fleet/mysql.js';
import { API, startMvpWorld, tick, type MvpWorld } from './world.js';

/**
 * Journey «reporte grande → job → notificación → descarga → revocación» over two real MySQL databases
 * and the HTTP surface (MVP-INTEGRATE, alcance 3). A report over the direct limit is queued, the tick of
 * the api process produces it, the person gets the «exportación lista» notice, downloads the file, and
 * loses the file and a pending job when their membership is revoked. Synthetic data only.
 */
const suite = adminUrl ? describe : describe.skip;

const ROWS = 5_001;

suite('Journey: reporte grande → job → notificación → descarga → revocación', () => {
  let w: MvpWorld;
  let exporter: MvpWorld['adminA'];
  let exporterId: string;
  beforeAll(async () => {
    w = await startMvpWorld();
    const member = await w.worldA.member('subject-admin-a', 'admin', 'subject-exporter-a');
    exporterId = member.identityId;
    exporter = await w.worldA.loginAs('subject-exporter-a');
    const area = await w.area(w.adminA, 'Flota exportación');
    await w.vehicle(w.adminA, area, 'EX1');
    // Past the direct limit without ten thousand HTTP calls: the rows go in with the administrator's
    // connection (a test fixture, never the runtime account), the same shape the module writes.
    await w.database.rows('SET SESSION cte_max_recursion_depth = 10000');
    await w.database.rows(
      `INSERT INTO opslog_vehicles
         (company_id, id, economic_number, economic_number_key, plate, plate_key, make, model, year,
          area_id, status, status_reason, odometer_km, registered_on, version, created_at, updated_at)
       WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       SELECT ?, CONCAT('mvp-big-', i), CONCAT('BIG-', i), CONCAT('big-', i), CONCAT('BP', i),
              CONCAT('bp', i), 'Kenworth', 'T680', 2020, ?, 'active', 'Alta', i, '2026-10-06', 1,
              NOW(6), NOW(6)
       FROM n`,
      [ROWS - 1, w.tenantA, area],
    );
  }, 180_000);
  afterAll(async () => w?.stop(), 60_000);

  const request = (browser: MvpWorld['adminA'], key: string) =>
    browser.post(`${API}/reports/vehicle_inventory/exports`, {
      json: { format: 'csv' },
      headers: { 'idempotency-key': key },
    });

  // Everything the journey does happens once, in order, here; each test below only reads what came back.
  const seen: {
    first?: BffExport;
    again?: BffExport;
    done?: BffExport;
    notices: { eventKind: string; link: string; title: string }[];
    file?: { status: number; text: string };
    others: number[];
    foreignNotices: string;
    trail: { action: string; entityId: string; entityType: string }[];
    outbox: { type: string }[];
    pending?: BffExport;
    afterRevoke: number;
    failed?: { status: string; failure: string | null } | undefined;
    completedByExporter: number;
  } = {
    notices: [],
    others: [],
    foreignNotices: '',
    trail: [],
    outbox: [],
    afterRevoke: 0,
    completedByExporter: 0,
  };

  beforeAll(async () => {
    const queued = await request(exporter, 'mvp-export-key-0001');
    expect(queued.status, queued.text).toBeLessThan(300);
    seen.first = queued.json as BffExport;
    seen.again = (await request(exporter, 'mvp-export-key-0001')).json as BffExport;
    const id = seen.first.id;
    // Two ticks, as the api process runs them: the first writes the file and the notice, the second delivers.
    await tick(w.platformA);
    await tick(w.platformA);
    seen.done = (await exporter.get(`${API}/exports/${id}`)).json as BffExport;
    seen.notices = (await exporter.get(`${API}/notifications?limit=100`)).json.items;
    const file = await exporter.get(`${API}/exports/${id}/download`);
    seen.file = {
      status: file.status,
      text: Buffer.from(file.bytes ?? file.text).toString('utf8'),
    };
    seen.others = [
      (await w.adminA.get(`${API}/exports/${id}/download`)).status,
      (await w.adminB.get(`${API}/exports/${id}/download`)).status,
      (await w.adminB.get(`${API}/exports/${id}`)).status,
    ];
    seen.foreignNotices = JSON.stringify(
      (await w.adminB.get(`${API}/notifications?limit=100`)).json,
    );
    seen.outbox = await w.database.rows<{ type: string }>(
      'SELECT type FROM opslog_tenant_outbox WHERE event_id = ?',
      [`export-completed-${id}`],
    );
    seen.trail = (await w.auditorA.get(`${API}/audit?limit=100`)).json.items;

    // The membership is revoked while a second job waits.
    const pending = await request(exporter, 'mvp-export-key-0002');
    seen.pending = pending.json as BffExport;
    const revoked = await w.adminA.post(`/api/users/${exporterId}/deactivate`, {
      json: { reason: 'Baja del recorrido' },
    });
    expect(revoked.status, revoked.text).toBeLessThan(300);
    seen.afterRevoke = (await exporter.get(`${API}/exports/${id}/download`)).status;
    await tick(w.platformA);
    const rows = await w.database.rows<{ status: string; failure: string | null }>(
      'SELECT status, failure FROM opslog_export_jobs WHERE id = ?',
      [seen.pending.id],
    );
    seen.failed = rows[0];
    const files = await w.database.rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM opslog_export_jobs WHERE status = 'completed' AND actor_id = ?",
      [exporterId],
    );
    seen.completedByExporter = Number(files[0]?.n);
  }, 240_000);

  it('queues a report over the direct limit instead of building it in the request', () => {
    expect(seen.first).toMatchObject({ mode: 'job', status: 'queued', format: 'csv' });
    expect(seen.again).toMatchObject({ id: seen.first?.id, replayed: true });
  });

  it('produces it on the tick and notifies the person without the content of the file', () => {
    expect(seen.done).toMatchObject({ status: 'completed', rowCount: ROWS });
    const ready = seen.notices.filter((item) => item.eventKind === 'export_ready');
    expect(ready.length).toBe(1);
    // The notice carries a label and a link, never the file name, a filter value or a figure.
    expect(JSON.stringify(ready[0])).not.toMatch(/BIG-|\.csv/);
    // The e-mail of the sink goes to company A only and carries no row of the file.
    const mail = w.mailA.messages.filter((message) => message.subject.includes('Exportación'));
    expect(mail.length).toBeGreaterThan(0);
    expect(w.mailB.messages.filter((message) => message.subject.includes('Exportación'))).toEqual(
      [],
    );
    expect(JSON.stringify(mail)).not.toMatch(/BIG-/);
    expect(seen.foreignNotices).not.toContain('export_ready');
  });

  it('serves the file only to the person who asked for it', () => {
    expect(seen.file?.status).toBe(200);
    expect(seen.file?.text).toContain('BIG-4999');
    expect(seen.file?.text.split('\n').filter((line) => line.includes('BIG-')).length).toBe(
      ROWS - 1,
    );
    // Another person of the same company and a person of the other company do not get it.
    expect(seen.others).toEqual([404, 404, 404]);
  });

  it('leaves the completion in the outbox and the export in the audit trail', () => {
    expect(seen.outbox).toEqual([{ type: 'export.completed' }]);
    const entry = seen.trail.find((item) => item.entityId === seen.first?.id);
    expect(
      entry,
      JSON.stringify(seen.trail.map((item) => [item.action, item.entityType])),
    ).toMatchObject({
      entityId: seen.first?.id,
    });
    expect(entry?.action).toMatch(/export/i);
  });

  it('drops the file and fails a pending job when the membership is revoked', () => {
    expect(seen.pending).toMatchObject({ mode: 'job', status: 'queued' });
    expect([401, 403, 404]).toContain(seen.afterRevoke);
    expect(seen.failed?.status).toBe('failed');
    expect(['permission_revoked', 'session_ended']).toContain(seen.failed?.failure);
    // No second file was written for the revoked person.
    expect(seen.completedByExporter).toBe(1);
  });
});
