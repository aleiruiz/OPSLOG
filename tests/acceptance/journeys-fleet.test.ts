import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  acceptance,
  dayFrom,
  drain,
  ok,
  startAcceptance,
  tag,
  tick,
  type AcceptanceWorld,
} from './support.js';

/**
 * SPECS §9.1 · recorridos de flota por la API real sobre MySQL: invitación, inicio de sesión y
 * revocación; alta de vehículo; asignación simultánea; documento y seguro renovados; importación y
 * exportación; drill-down del dashboard. Datos sintéticos.
 */
acceptance('Recorridos de flota (SPECS §9.1)', { timeout: 120_000 }, () => {
  let w: AcceptanceWorld;
  beforeAll(async () => {
    w = await startAcceptance();
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  }, 60_000);

  it('J1 invita, acepta con una identidad nueva, inicia sesión y pierde el acceso al desactivarla', async () => {
    const invited = ok(
      await w.adminA.post('/api/users/invitations', { json: { roleId: 'editor' } }),
    );
    const token = invited.json.invitationToken as string;
    const guest = w.fleet.worldA.browser();
    await w.fleet.worldA.prepare(guest);
    const inspected = ok(await guest.post('/api/auth/invitations/inspect', { json: { token } }));
    expect(inspected.json).toBeTruthy();
    const accepted = ok(
      await guest.post('/api/auth/invitations/accept', {
        json: { token, ...w.fleet.worldA.credentials('subject-guest-j1') },
      }),
    );
    guest.csrf = (accepted.json.csrfToken as string | undefined) ?? guest.csrf;
    const session = ok(await guest.get('/api/auth/session'));
    const userId = session.json.user.id as string;
    expect(ok(await guest.get('/api/vehicles')).status).toBe(200);
    // La invitación es de un solo uso: repetirla no crea otra membresía.
    const again = await guest.post('/api/auth/invitations/accept', {
      json: { token, ...w.fleet.worldA.credentials('subject-guest-j1b') },
    });
    expect(again.status).toBeGreaterThanOrEqual(400);

    ok(
      await w.adminA.post(`/api/users/${userId}/deactivate`, {
        json: { reason: 'Baja sintética' },
      }),
    );
    // Revocación inmediata: la sesión viva deja de servir en la siguiente llamada (NFR-S5, BR-023).
    expect((await guest.get('/api/vehicles')).status).toBe(401);
    // La empresa B ni siquiera ve al usuario.
    const listB = ok(await w.adminB.get('/api/users'));
    expect(JSON.stringify(listB.json)).not.toContain(userId);
  });

  it('J2 da de alta un vehículo con documento y póliza y lo deja visible en lista, ficha e historial', async () => {
    const area = await w.fleet.area(w.adminA, `Flota ${tag('J2')}`);
    const vehicleId = await w.fleet.vehicle(w.adminA, area, tag('J2V'));
    const doc = ok(
      await w.adminA.post('/api/documents', {
        json: {
          ownerType: 'vehicle',
          ownerId: vehicleId,
          typeCode: 'registration_card',
          title: 'Tarjeta sintética',
          documentNumber: `DOC-${tag('J2')}`,
          issuedOn: dayFrom(-300),
          expiresOn: dayFrom(200),
        },
      }),
      201,
    );
    const policy = ok(
      await w.adminA.post('/api/insurance-policies', {
        json: {
          vehicleId,
          insurer: 'Aseguradora Sintética',
          policyNumber: `POL-${tag('J2')}`,
          coverageType: 'comprehensive',
          startsOn: dayFrom(-100),
          endsOn: dayFrom(200),
        },
      }),
      201,
    );
    expect(ok(await w.adminA.get(`/api/vehicles/${vehicleId}`)).json.status).toBe('active');
    expect(ok(await w.adminA.get(`/api/documents/${doc.json.id}`)).json.status).toBe('valid');
    expect(ok(await w.adminA.get(`/api/insurance-policies/${policy.json.id}`)).json.status).toBe(
      'valid',
    );
    const history = ok(await w.adminA.get(`/api/vehicles/${vehicleId}/history`));
    expect(history.json.items.length).toBeGreaterThan(0);
    // Un odómetro menor al actual se rechaza (BR-015) y el vehículo ajeno es 404 uniforme (NFR-S8).
    const lower = await w.adminA.post(`/api/vehicles/${vehicleId}/odometer`, {
      json: { version: 1, odometerKm: 1 },
    });
    expect(lower.status).toBeGreaterThanOrEqual(400);
    expect((await w.adminB.get(`/api/vehicles/${vehicleId}`)).status).toBe(404);
  });

  it('J3 resuelve la asignación principal simultánea: una gana y la otra recibe conflicto', async () => {
    const area = await w.fleet.area(w.adminA, `Flota ${tag('J3')}`);
    const vehicleId = await w.fleet.vehicle(w.adminA, area, tag('J3V'));
    const first = await w.fleet.driver(w.adminA, area, tag('J3D'));
    const second = await w.fleet.driver(w.adminA, area, tag('J3E'));
    const body = (employeeId: string) => ({
      json: { vehicleId, employeeId, type: 'principal', reason: 'Asignación simultánea sintética' },
    });
    const [a, b] = await Promise.all([
      w.adminA.post('/api/vehicle-assignments', body(first)),
      w.adminA2.post('/api/vehicle-assignments', body(second)),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0], `${a.text} ${b.text}`).toBe(201);
    expect(statuses[1], `${a.text} ${b.text}`).toBeGreaterThanOrEqual(409);
    const active = ok(
      await w.adminA.get(`/api/vehicle-assignments?vehicleId=${vehicleId}&status=current`),
    );
    const principal = (active.json.items as { type: string }[]).filter(
      (x) => x.type === 'principal',
    );
    expect(principal).toHaveLength(1);
  });

  it('J4 renueva documento y póliza conservando la versión anterior en el historial', async () => {
    const area = await w.fleet.area(w.adminA, `Flota ${tag('J4')}`);
    const vehicleId = await w.fleet.vehicle(w.adminA, area, tag('J4V'));
    const doc = ok(
      await w.adminA.post('/api/documents', {
        json: {
          ownerType: 'vehicle',
          ownerId: vehicleId,
          typeCode: 'registration_card',
          title: 'Tarjeta por vencer',
          documentNumber: `DOC-${tag('J4')}`,
          issuedOn: dayFrom(-300),
          expiresOn: dayFrom(5),
        },
      }),
      201,
    );
    expect(ok(await w.adminA.get(`/api/documents/${doc.json.id}`)).json.status).toBe('expiring');
    const renewed = ok(
      await w.adminA.post(`/api/documents/${doc.json.id}/renew`, {
        json: { version: doc.json.version ?? 1, issuedOn: dayFrom(0), expiresOn: dayFrom(365) },
      }),
    );
    expect(renewed.json.status).toBe('valid');
    const docHistory = ok(await w.adminA.get(`/api/documents/${doc.json.id}/history`));
    expect(docHistory.json.items).toHaveLength(2);

    const policy = ok(
      await w.adminA.post('/api/insurance-policies', {
        json: {
          vehicleId,
          insurer: 'Aseguradora Sintética',
          policyNumber: `POL-${tag('J4')}`,
          coverageType: 'comprehensive',
          startsOn: dayFrom(-360),
          endsOn: dayFrom(-1),
        },
      }),
      201,
    );
    expect(policy.json.status).toBe('expired');
    const renewal = ok(
      await w.adminA.post(`/api/insurance-policies/${policy.json.id}/renew`, {
        json: { version: policy.json.version ?? 1, startsOn: dayFrom(0), endsOn: dayFrom(365) },
      }),
    );
    expect(renewal.json.status).toBe('valid');
    const policyHistory = ok(
      await w.adminA.get(`/api/insurance-policies/${policy.json.id}/history`),
    );
    expect(policyHistory.json.items.map((i: { revision: number }) => i.revision)).toEqual([2, 1]);
    await tick(w.fleet.platformA);
  });

  it('J7 importa una flota con filas inválidas, confirma las válidas y exporta lo importado', async () => {
    const area = await w.fleet.area(w.adminA, `Flota ${tag('J7')}`);
    const prefix = tag('IMP');
    const rows = Array.from({ length: 20 }, (_, i) => {
      const n = String(i).padStart(3, '0');
      // Las filas 3 y 7 repiten la placa de otra fila: deben quedar como errores con fila y motivo.
      const plate = i === 3 ? `${prefix}000` : i === 7 ? `${prefix}001` : `${prefix}${n}`;
      return `${prefix}-E${n},${plate},Toyota,Hilux,2022,${area},10,`;
    });
    const csv = ['economicNumber,plate,make,model,year,areaId,odometerKm,vin', ...rows, ''].join(
      '\r\n',
    );
    const preview = ok(
      await w.adminA.post('/api/imports', { json: { entity: 'vehicle', mode: 'dry_run', csv } }),
      201,
    );
    expect(preview.json.job).toMatchObject({ totalRows: 20, invalidRows: 2, importedRows: 0 });
    const errors = ok(
      await w.adminA.get(`/api/imports/${preview.json.job.id}/rows?outcome=invalid&limit=25`),
    );
    expect(errors.json.items.length).toBe(2);
    const commit = ok(
      await w.adminA.post('/api/imports', {
        json: {
          entity: 'vehicle',
          mode: 'commit_valid',
          idempotencyKey: `acc-import-${prefix}`,
          dryRunJobId: preview.json.job.id,
          csv,
        },
      }),
      201,
    );
    expect(commit.json.job).toMatchObject({ validRows: 18, importedRows: 18, invalidRows: 2 });
    const exported = ok(
      await w.adminA.post('/api/v1/reports/vehicle_inventory/exports', {
        json: { format: 'csv' },
        headers: { 'idempotency-key': `acc-export-${prefix}-0001` },
      }),
    );
    expect(exported.json.status).toBe('completed');
    const file = ok(await w.adminA.get(`/api/v1/exports/${exported.json.id}/download`));
    const text = Buffer.from(file.bytes ?? file.text).toString('utf8');
    expect(text).toContain(`${prefix}-E000`);
    // La exportación de A no contiene filas de B (FR-002, §22).
    const other = ok(
      await w.adminB.post('/api/v1/reports/vehicle_inventory/exports', {
        json: { format: 'csv' },
        headers: { 'idempotency-key': `acc-export-${prefix}-0002` },
      }),
    );
    const fileB = ok(await w.adminB.get(`/api/v1/exports/${other.json.id}/download`));
    expect(Buffer.from(fileB.bytes ?? fileB.text).toString('utf8')).not.toContain(prefix);
    await drain(w.fleet.platformA);
  });

  it('J8 hace drill-down del dashboard: cada widget baja a un listado con la misma cifra', async () => {
    const area = await w.fleet.area(w.adminA, `Flota ${tag('J8')}`);
    for (let i = 0; i < 3; i += 1) await w.fleet.vehicle(w.adminA, area, tag('J8V'));
    const dashboard = ok(await w.adminA.get(`/api/v1/dashboard?areaId=${area}`));
    const widget = dashboard.json.widgets.find((x: { id: string }) => x.id === 'vehicles_active');
    expect(widget.value).toBe(3);
    expect(widget.drilldown.target).toBe('vehicles');
    const query = new URLSearchParams({ ...widget.drilldown.filters, areaId: area, limit: '100' });
    const list = ok(await w.adminA.get(`/api/vehicles?${query}`));
    expect(list.json.total).toBe(widget.value);
    // El mismo tablero de la empresa B no cuenta los vehículos de A.
    const dashboardB = ok(await w.adminB.get('/api/v1/dashboard'));
    const widgetB = dashboardB.json.widgets.find((x: { id: string }) => x.id === 'vehicles_active');
    expect(widgetB.value).toBe(0);
    // El área de A no existe para B: el filtro se rechaza sin revelar nada.
    const foreignArea = await w.adminB.get(`/api/v1/dashboard?areaId=${area}`);
    expect([404, 422]).toContain(foreignArea.status);
    expect(foreignArea.text).not.toContain(area);
  });
});
