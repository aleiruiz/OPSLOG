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
  let first: BffExport;

  it('queues a report over the direct limit instead of building it in the request', async () => {
    const reply = await request(exporter, 'mvp-export-key-0001');
    expect(reply.status, reply.text).toBeLessThan(300);
    first = reply.json as BffExport;
    expect(first).toMatchObject({ mode: 'job', status: 'queued', format: 'csv' });
    const again = await request(exporter, 'mvp-export-key-0001');
    expect(again.json).toMatchObject({ id: first.id, replayed: true });
  }, 120_000);

  it('produces it on the tick, notifies the person and serves the file only to them', async () => {
    // Two ticks, as the api process runs them: the first writes the file and the notice, the second delivers.
    await tick(w.platformA);
    await tick(w.platformA);
    const done = await exporter.get(`${API}/exports/${first.id}`);
    expect(done.json).toMatchObject({ status: 'completed', rowCount: ROWS });

    const notices = await exporter.get(`${API}/notifications?limit=100`);
    const ready = (
      notices.json.items as { eventKind: string; link: string; title: string }[]
    ).filter((item) => item.eventKind === 'export_ready');
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

    const file = await exporter.get(`${API}/exports/${first.id}/download`);
    expect(file.status, file.text).toBe(200);
    const text = Buffer.from(file.bytes ?? file.text).toString('utf8');
    expect(text).toContain('BIG-4999');
    expect(text.split('\n').filter((line) => line.includes('BIG-')).length).toBe(ROWS - 1);

    // Another person of the same company and a person of the other company do not get the file.
    expect((await w.adminA.get(`${API}/exports/${first.id}/download`)).status).toBe(404);
    expect((await w.adminB.get(`${API}/exports/${first.id}/download`)).status).toBe(404);
    expect((await w.adminB.get(`${API}/exports/${first.id}`)).status).toBe(404);
    const foreign = await w.adminB.get(`${API}/notifications?limit=100`);
    expect(JSON.stringify(foreign.json)).not.toContain('export_ready');
  }, 120_000);

  it('leaves the export and its completion in the audit trail and the outbox', async () => {
    await tick(w.platformA);
    const events = await w.database.rows<{ type: string }>(
      'SELECT type FROM opslog_tenant_outbox WHERE event_id = ?',
      [`export-completed-${first.id}`],
    );
    expect(events).toEqual([{ type: 'export.completed' }]);
    const trail = await w.auditorA.get(`${API}/audit?limit=100`);
    expect(trail.status, trail.text).toBe(200);
    expect(JSON.stringify(trail.json.items)).toMatch(/export/i);
  }, 120_000);

  it('drops the file and fails a pending job when the membership is revoked', async () => {
    const pending = await request(exporter, 'mvp-export-key-0002');
    expect(pending.json).toMatchObject({ mode: 'job', status: 'queued' });
    const revoked = await w.adminA.post(`/api/users/${exporterId}/deactivate`, {
      json: { reason: 'Baja del recorrido' },
    });
    expect(revoked.status, revoked.text).toBeLessThan(300);

    expect([401, 403, 404]).toContain(
      (await exporter.get(`${API}/exports/${first.id}/download`)).status,
    );
    await tick(w.platformA);
    const rows = await w.database.rows<{ status: string; failure: string | null }>(
      'SELECT status, failure FROM opslog_export_jobs WHERE id = ?',
      [(pending.json as BffExport).id],
    );
    expect(rows[0]?.status).toBe('failed');
    expect(['permission_revoked', 'session_ended']).toContain(rows[0]?.failure);
    // No second file was written for the revoked person.
    const files = await w.database.rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM opslog_export_jobs WHERE status = 'completed' AND actor_id = ?",
      [exporterId],
    );
    expect(Number(files[0]?.n)).toBe(1);
  }, 120_000);
});
