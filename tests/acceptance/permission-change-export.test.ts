import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  acceptance,
  key,
  ok,
  relayAudit,
  startAcceptance,
  tag,
  tick,
  type AcceptanceWorld,
} from './support.js';

const R = '/api/v1/reports';
const E = '/api/v1/exports';
/** Sobre el límite directo de 5.000 filas: el trabajo queda en cola y lo produce el worker. */
const POLICIES = 5_001;

interface JobRow {
  readonly status: string;
  readonly failure: string | null;
  readonly file_name: string | null;
  readonly row_count: number | null;
}

/**
 * Cambio de permisos con un trabajo pendiente (SPECS §4.4, FIX-QA-24): una exportación en cola cuyo
 * creador deja de poder exportar costos antes de que corra el worker. El archivo no se produce, no
 * hay descarga ni aviso de «exportación lista» para esa persona, y el trabajo de otra persona con
 * permiso sigue su curso. Las plantillas de rol sintéticas solo dan `export` y `view_costs` juntas
 * (administrador): el caso es la baja de ese rol, no la pérdida suelta de `view_costs`; la rama por
 * columna sensible está cubierta por `packages/domain/exports/src/service.test.ts`.
 */
acceptance('Cambio de permisos con exportación pendiente', { timeout: 180_000 }, () => {
  let w: AcceptanceWorld;
  let costs: AcceptanceWorld['adminA'];
  let costsId: string;
  let adminToken = '';

  beforeAll(async () => {
    w = await startAcceptance();
    const member = await w.fleet.worldA.member('subject-admin-a', 'admin', 'subject-costs-a');
    costsId = member.identityId;
    costs = await w.fleet.worldA.loginAs('subject-costs-a');
    const area = await w.fleet.area(w.adminA, tag('Área QA24 '));
    const vehicle = await w.fleet.vehicle(w.adminA, area, tag('Q24'));
    // Pasado el límite directo sin cinco mil llamadas HTTP: las pólizas entran con la conexión
    // de administración de la prueba (fixture sintético, nunca la cuenta de ejecución).
    await w.database.rows('SET SESSION cte_max_recursion_depth = 10000');
    await w.database.rows(
      `INSERT INTO opslog_insurance_policies
         (company_id, id, vehicle_id, insurer, coverage_notes, revision, policy_number, coverage_type,
          starts_on, ends_on, deductible_kind, deductible_value, deductible_currency, version,
          created_at, updated_at, archived_at)
       WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       SELECT ?, CONCAT('qa24-pol-', i), ?, 'Aseguradora Sintética QA', NULL, 1, CONCAT('QA24-', i),
              'comprehensive', '2026-01-01', '2027-01-01', 'amount', 123456, 'MXN', 1,
              NOW(6), NOW(6), NULL
       FROM n`,
      [POLICIES, w.fleet.tenantA, vehicle],
    );
    const login = await w.fleet.worldA.platform.signIn(
      await w.fleet.worldA.principal('subject-admin-a'),
    );
    adminToken = login.value?.token as string;
  }, 240_000);
  afterAll(async () => {
    await w?.close();
  }, 60_000);

  const request = (who: AcceptanceWorld['adminA']) =>
    who.post(`${R}/insurance/exports`, { json: { format: 'csv' }, headers: key() });
  const jobRow = async (id: string): Promise<JobRow | undefined> =>
    (
      await w.database.rows<JobRow>(
        'SELECT status, failure, file_name, row_count FROM opslog_export_jobs WHERE id = ?',
        [id],
      )
    )[0];

  it('el trabajo en cola de quien pierde el permiso falla sin producir archivo y el de otra persona sigue', async () => {
    const mine = await request(costs);
    expect(mine.status, mine.text).toBeLessThan(300);
    expect(mine.json).toMatchObject({ mode: 'job', status: 'queued' });
    const peer = await request(w.adminA);
    expect(peer.json).toMatchObject({ mode: 'job', status: 'queued' });

    // El permiso cambia mientras ambos trabajos esperan: la persona baja a un rol sin exportar.
    const changed = await w.fleet.worldA.platform.changeRole(
      adminToken,
      'qa24-role',
      costsId,
      'editor',
    );
    expect(changed.ok).toBe(true);

    await tick(w.fleet.platformA, 'exports.run');
    await tick(w.fleet.platformA, 'exports.run');

    const failed = await jobRow(mine.json.id);
    expect(failed?.status).toBe('failed');
    expect(['permission_revoked', 'session_ended']).toContain(failed?.failure);
    expect(failed?.file_name).toBeNull();
    expect(failed?.row_count).toBeNull();
    // Control: el worker corrió y el trabajo de la administradora, con permiso, sí terminó.
    const done = await jobRow(peer.json.id);
    expect(done).toMatchObject({ status: 'completed', row_count: POLICIES });
    const file = ok(await w.adminA.get(`${E}/${peer.json.id}/download`));
    expect(Buffer.from(file.bytes ?? '').toString('utf8')).toContain('1234.56');
  });

  it('quien perdió el permiso no descarga, no ve el trabajo ni recibe el aviso de listo', async () => {
    const jobs = await w.database.rows<{ id: string }>(
      "SELECT id FROM opslog_export_jobs WHERE actor_id = ? AND status = 'completed'",
      [costsId],
    );
    expect(jobs).toEqual([]);
    // La sesión anterior terminó con el cambio de rol: un nuevo ingreso ya es de editor.
    const stale = await costs.get(E);
    expect(stale.status).toBe(401);
    const again = await w.fleet.worldA.loginAs('subject-costs-a');
    expect((await request(again)).status).toBe(403);
    const own = ok(await again.get(E)).json.items as { status: string }[];
    expect(own.every((item) => item.status !== 'completed')).toBe(true);
    const notices = ok(await again.get('/api/v1/notifications?limit=100')).json.items as {
      eventKind: string;
    }[];
    expect(notices.filter((item) => item.eventKind === 'export_ready')).toEqual([]);
    // Tampoco puede leer el archivo de la administradora.
    const peerJobs = ok(await w.adminA.get(E)).json.items as { id: string }[];
    for (const item of peerJobs)
      expect([401, 403, 404]).toContain((await again.get(`${E}/${item.id}/download`)).status);
  });

  it('el cambio de rol y la caída del trabajo quedan en audit, sin el contenido de las filas', async () => {
    await relayAudit(w);
    const audit = ok(await w.adminA.get('/api/v1/audit?limit=100')).json.items as {
      action: string;
    }[];
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('membership.role_changed');
    expect(JSON.stringify(audit)).not.toContain('1234.56');
  });
});
