import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Browser } from '../../apps/api/bff/src/test-support.js';
import {
  acceptance,
  dayFrom,
  evidenceBody,
  key,
  ok,
  reindex,
  startAcceptance,
  tag,
  tick,
  type AcceptanceWorld,
} from './support.js';

const WO = '/api/v1/work-orders';
const INC = '/api/v1/incidents';

/**
 * SPECS §9.1 · mantenimiento completo, siniestro completo, rechazado y reabierto, y búsqueda con
 * permisos, por la API real sobre MySQL. Las transiciones, los requisitos faltantes y los permisos
 * se comprueban por la respuesta HTTP; no se toca ningún almacén. Datos sintéticos.
 */
acceptance(
  'Recorridos de mantenimiento, siniestros y búsqueda (SPECS §9.1)',
  { timeout: 120_000 },
  () => {
    let w: AcceptanceWorld;
    let adminId: string;
    beforeAll(async () => {
      w = await startAcceptance();
      adminId = (await w.adminA.get('/api/auth/session')).json.user.id as string;
    }, 180_000);
    afterAll(async () => {
      await w?.close();
    }, 60_000);

    async function fixture() {
      const area = await w.fleet.area(w.adminA, `Flota ${tag('C')}`);
      const vehicleId = await w.fleet.vehicle(w.adminA, area, tag('CV'));
      const policy = ok(
        await w.adminA.post('/api/insurance-policies', {
          json: {
            vehicleId,
            insurer: 'Aseguradora Sintética',
            policyNumber: `POL-${tag('C')}`,
            coverageType: 'comprehensive',
            startsOn: dayFrom(-100),
            endsOn: dayFrom(200),
          },
        }),
        201,
      );
      return { area, vehicleId, policyId: policy.json.id as string };
    }

    /** Transición de siniestro por HTTP: devuelve la versión nueva o la respuesta de rechazo. */
    async function go(
      id: string,
      version: number,
      command: string,
      extra: Record<string, unknown> = {},
    ) {
      return w.adminA.post(`${INC}/${id}/transitions`, {
        json: { command, version, ...extra },
        headers: key(),
      });
    }
    async function step(
      id: string,
      version: number,
      command: string,
      extra: Record<string, unknown> = {},
    ) {
      const reply = ok(await go(id, version, command, extra));
      return reply.json.version as number;
    }
    async function put(
      id: string,
      section: 'insurance' | 'resolution',
      version: number,
      body: object,
    ) {
      return ok(await w.adminA.put(`${INC}/${id}/${section}`, { json: { version, ...body } })).json
        .version as number;
    }
    async function draft(vehicleId: string, over: Record<string, unknown> = {}) {
      const created = ok(
        await w.adminA.post(INC, {
          json: {
            vehicleId,
            type: 'collision',
            severity: 'medium',
            occurredAt: new Date().toISOString(),
            location: { text: 'Calle Sintética' },
            description: 'Descripción sintética del siniestro',
            vehicleOperable: true,
            noDriverReason: 'Vehículo estacionado',
            noPhotoJustification: 'Sin foto disponible',
            ...over,
          },
        }),
        201,
      );
      return created.json as { id: string; version: number; folio: string };
    }
    async function underReview(vehicleId: string, over: Record<string, unknown> = {}) {
      const created = await draft(vehicleId, over);
      const reported = await step(created.id, created.version, 'report');
      const assigned = await step(created.id, reported, 'assign', { responsibleId: adminId });
      return { id: created.id, version: await step(created.id, assigned, 'review') };
    }

    it('J5 lleva una orden correctiva de abierta a cerrada y deja el vehículo operativo', async () => {
      const { vehicleId } = await fixture();
      const created = ok(
        await w.adminA.post(WO, {
          json: { vehicleId, description: 'Ruido en suspensión sintético' },
        }),
        201,
      );
      const id = created.json.id as string;
      const t = (json: Record<string, unknown>, headers: Record<string, string> = {}) =>
        w.adminA.post(`${WO}/${id}/transitions`, { json, headers });
      let version = created.json.version as number;
      const workshop = ok(
        await w.adminA.post('/api/v1/maintenance/workshops', {
          json: { name: `Taller ${tag('T')}`, specialties: ['servicio'] },
        }),
        201,
      );
      const missing = await t({ command: 'assign', version, responsibleId: adminId });
      expect(missing.json.missingRequirements).toEqual(
        expect.arrayContaining(['scheduledDate', 'workshopOrMechanic']),
      );
      const assigned = ok(
        await t({
          command: 'assign',
          version,
          responsibleId: adminId,
          workshopId: workshop.json.id,
          scheduledDate: dayFrom(0),
        }),
      );
      version = assigned.json.version;
      const started = ok(await t({ command: 'start', version }));
      version = started.json.version;
      // Cerrar sin completar el trabajo se rechaza: la regla del workflow vive en el servidor.
      const early = await t({ command: 'close', version, vehicleStatus: 'active' }, key());
      expect(early.status).toBeGreaterThanOrEqual(400);
      const worked = ok(
        await w.adminA.put(`${WO}/${id}/work`, {
          json: { version, tasks: [{ description: 'Cambio de bujes' }] },
        }),
      );
      version = worked.json.version;
      const completed = ok(
        await t({ command: 'complete', version, actualDate: dayFrom(0), actualKm: 100 }),
      );
      version = completed.json.version;
      const closed = ok(await t({ command: 'close', version, vehicleStatus: 'active' }, key()));
      expect(closed.json).toMatchObject({ status: 'closed' });
      // Un viewer no puede mover la orden y otra empresa no la ve.
      expect(
        (
          await w.viewerA.post(`${WO}/${id}/transitions`, {
            json: { command: 'cancel', version: 1, reason: 'x' },
          })
        ).status,
      ).toBe(403);
      expect((await w.adminB.get(`${WO}/${id}`)).status).toBe(404);
      expect(ok(await w.adminA.get(`/api/vehicles/${vehicleId}`)).json.status).toBe('active');
    });

    it('J6a lleva un siniestro del borrador al cierre por la vía de la aseguradora con permisos y faltantes', async () => {
      const { vehicleId, policyId } = await fixture();
      const created = await draft(vehicleId, { policyId });
      const reported = await step(created.id, created.version, 'report');
      const assigned = await step(created.id, reported, 'assign', { responsibleId: adminId });
      const review = await step(created.id, assigned, 'review');
      const lacking = await go(created.id, review, 'insure');
      expect(lacking.status).toBe(422);
      expect(lacking.json.missingRequirements).toEqual(
        expect.arrayContaining(['insurer', 'claim_number', 'insurer_reported_on']),
      );
      const filed = await put(created.id, 'insurance', review, {
        insurerName: 'Aseguradora Sintética',
        claimNumber: 'REP-ACEPTADO',
        insurerReportedOn: dayFrom(0),
      });
      const insured = await step(created.id, filed, 'insure');
      const accepted = await put(created.id, 'insurance', insured, { insurerResult: 'accepted' });
      const summary = await put(created.id, 'resolution', accepted, {
        resolutionSummary: 'Resuelto con la aseguradora de forma sintética',
        vehicleStatusDecision: 'active',
      });
      const resolved = await step(created.id, summary, 'resolve');
      // Quien solo consulta no cierra (US-032) ni ve importes (BR-I6); la otra empresa no ve el caso.
      const denied = await w.viewerA.post(`${INC}/${created.id}/transitions`, {
        json: { command: 'close', version: resolved },
        headers: key(),
      });
      expect(denied.status).toBe(403);
      expect((await w.viewerA.get(`${INC}/${created.id}/costs`)).status).toBe(403);
      expect((await w.adminB.get(`${INC}/${created.id}`)).status).toBe(404);
      await step(created.id, resolved, 'close');
      const view = ok(await w.adminA.get(`${INC}/${created.id}`)).json;
      expect(view).toMatchObject({ status: 'closed', cycle: 1 });
      const timeline = ok(await w.adminA.get(`${INC}/${created.id}/timeline`)).json.items;
      expect(JSON.stringify(timeline)).toContain('close');
      // Un siniestro cerrado es inmutable salvo reapertura (BR-I7).
      const edit = await w.adminA.send('PATCH', `${INC}/${created.id}`, {
        json: { version: view.version, severity: 'low' },
      });
      expect(edit.status).toBeGreaterThanOrEqual(400);
    });

    it('J6b registra el rechazo de la aseguradora con carta y deja el caso esperando decisión (US-033)', async () => {
      const { vehicleId, policyId } = await fixture();
      const review = await underReview(vehicleId, { policyId });
      const filed = await put(review.id, 'insurance', review.version, {
        insurerName: 'Aseguradora Sintética',
        claimNumber: 'REP-RECHAZO',
        insurerReportedOn: dayFrom(0),
      });
      const insured = await step(review.id, filed, 'insure');
      const reason = await put(review.id, 'insurance', insured, {
        rejectionReason: 'Motivo de rechazo sintético',
      });
      // Rechazar sin la carta se bloquea con la lista de faltantes.
      const blocked = await go(review.id, reason, 'reject');
      expect(blocked.status).toBe(422);
      const letter = ok(
        await w.adminA.post(`${INC}/${review.id}/evidence`, {
          json: evidenceBody(reason, 'rejection_letter'),
        }),
        201,
      );
      await w.fleet.platformA.pipeline.processScans();
      await step(review.id, letter.json.version, 'reject');
      expect(ok(await w.adminA.get(`${INC}/${review.id}`)).json.status).toBe('insurance_rejected');
    });

    it('J6c reabre un siniestro cerrado solo con permiso, motivo y clave, y vuelve a cerrarlo', async () => {
      const { vehicleId } = await fixture();
      const review = await underReview(vehicleId, { policyId: null, type: 'other' });
      const decided = await put(review.id, 'insurance', review.version, {
        noInsuranceReason: 'Sin póliza sintética',
      });
      const noInsurance = await step(review.id, decided, 'no_insurance');
      const assumed = await put(review.id, 'resolution', noInsurance, {
        costAssumed: true,
        resolutionSummary: 'Primer cierre sintético',
        vehicleStatusDecision: 'active',
      });
      const resolved = await step(review.id, assumed, 'resolve');
      const closed = await step(review.id, resolved, 'close');

      const viewerTry = await w.viewerA.post(`${INC}/${review.id}/transitions`, {
        json: { command: 'reopen', version: closed, reason: 'Intento sin permiso' },
        headers: key(),
      });
      expect(viewerTry.status).toBe(403);
      const noReason = await go(review.id, closed, 'reopen');
      expect(noReason.status).toBe(422);
      const headers = key();
      const body = { command: 'reopen', version: closed, reason: 'Nueva evidencia sintética' };
      const reopened = await w.adminA.post(`${INC}/${review.id}/transitions`, {
        json: body,
        headers,
      });
      expect(reopened.status, reopened.text).toBe(200);
      expect(reopened.json).toMatchObject({ status: 'reopened', cycle: 2 });
      const replay = await w.adminA.post(`${INC}/${review.id}/transitions`, {
        json: body,
        headers,
      });
      expect(replay.json).toEqual(reopened.json);
      const clash = await w.adminA.post(`${INC}/${review.id}/transitions`, {
        json: { ...body, reason: 'Otro motivo' },
        headers,
      });
      expect(clash.status).toBe(409);
    });

    it('J9 busca con permisos: encuentra por placa, oculta tipos sin permiso y no cruza empresas', async () => {
      const area = await w.fleet.area(w.adminA, `Flota ${tag('S')}`);
      const unit = tag('SV');
      const vehicleId = await w.fleet.vehicle(w.adminA, area, unit);
      const license = `LIC-ACC-${tag('L')}`;
      const driver = ok(
        await w.adminA.post('/api/employees', {
          json: {
            kind: 'driver',
            firstName: 'Ana',
            lastName: 'Buscable',
            areaId: area,
            employeeNumber: `EMP-${tag('SD')}`,
            idType: 'ine',
            nationalId: `SYNTH-ID-${tag('N')}`,
            licenseNumber: license,
            licenseType: 'c',
            licenseExpiresOn: dayFrom(400),
          },
        }),
        201,
      );
      const driverId = driver.json.id as string;
      await tick(w.fleet.platformA);
      await reindex(w.fleet.platformA, w.fleet.tenantA);
      const find = async (browser: Browser, q: string) =>
        ok(await browser.get(`/api/v1/search?q=${encodeURIComponent(q)}`)).json.groups as {
          type: string;
          items: { id: string }[];
        }[];
      const ids = (groups: Awaited<ReturnType<typeof find>>, type: string) =>
        groups.find((g) => g.type === type)?.items.map((i) => i.id) ?? [];
      // Tolerante a acentos y guiones (FR-160): la placa FL<unit> se halla sin el formato exacto.
      expect(ids(await find(w.adminA, `fl${unit.toLowerCase()}`), 'vehicle')).toEqual([vehicleId]);
      expect(ids(await find(w.viewerA, `FL${unit}`), 'vehicle')).toEqual([vehicleId]);
      // Empresa B no encuentra nada de A, ni siquiera con la placa exacta (FR-002 §22).
      const other = await find(w.adminB, `FL${unit}`);
      expect(other.flatMap((g) => g.items)).toEqual([]);
      // La licencia es PII: solo se halla por coincidencia exacta y con view_pii (SPECS D23).
      expect(ids(await find(w.adminA, license), 'driver')).toEqual([driverId]);
      expect(ids(await find(w.adminA, license.slice(0, 9)), 'driver')).toEqual([]);
      expect(ids(await find(w.viewerA, license), 'driver')).toEqual([]);
      expect(ids(await find(w.adminA, 'buscable'), 'driver')).toEqual([driverId]);
    });
  },
);
