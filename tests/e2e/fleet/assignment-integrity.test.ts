import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminUrl, startFleetDatabase, type FleetDatabase } from './mysql.js';
import { startFleetWorld, type FleetWorld } from './world.js';

const suite = adminUrl ? describe : describe.skip;
const ASSIGNMENTS = '/api/vehicle-assignments';

suite('integrated assignment integrity on real MySQL', () => {
  let database: FleetDatabase;
  let fleet: FleetWorld;

  beforeAll(async () => {
    database = await startFleetDatabase();
    fleet = await startFleetWorld(database);
  }, 120_000);

  afterAll(async () => {
    fleet?.world.dispose();
    await database?.close();
  }, 60_000);

  it('allows the current expired-license rule, enforces tenant and role boundaries, and serializes principal replacement', async () => {
    const areaId = await fleet.area(fleet.adminA, 'Asignaciones');
    const vehicleId = await fleet.vehicle(fleet.adminA, areaId, 'ASG01');
    const expiredDriver = await fleet.driver(fleet.adminA, areaId, 'ASG-EXPIRED', '2020-01-01');
    const nextDriver = await fleet.driver(fleet.adminA, areaId, 'ASG-NEXT');
    const raceDriver = await fleet.driver(fleet.adminA, areaId, 'ASG-RACE');

    const fitness = await fleet.adminA.get(`/api/employees/${expiredDriver}`);
    expect(fitness.status, fitness.text).toBe(200);
    expect(fitness.json.fitness).toEqual({ fit: false, reasons: ['license_expired'] });

    const created = await fleet.adminA.post(ASSIGNMENTS, {
      json: {
        vehicleId,
        employeeId: expiredDriver,
        type: 'principal',
        reason: 'Regla BR-014 vigente',
      },
    });
    expect(created.status, created.text).toBe(201);
    const oldId = created.json.assignment.id as string;

    const hidden = await fleet.adminB.get(`${ASSIGNMENTS}/${oldId}`);
    expect(hidden.status).toBe(404);
    const foreignMutation = await fleet.adminB.post(ASSIGNMENTS, {
      json: {
        vehicleId,
        employeeId: expiredDriver,
        type: 'principal',
        reason: 'IDs de otro tenant',
      },
    });
    expect(foreignMutation.status).toBe(422);
    expect(foreignMutation.json).toMatchObject({ code: 'invalid_vehicle' });
    expect(foreignMutation.text).not.toContain(vehicleId);
    expect(foreignMutation.text).not.toContain(expiredDriver);
    expect(
      await database.rows(
        'SELECT id FROM opslog_vehicle_assignments WHERE company_id = ? AND vehicle_id = ?',
        [fleet.tenantB, vehicleId],
      ),
    ).toEqual([]);
    expect(
      (
        await fleet.viewerA.post(ASSIGNMENTS, {
          json: {
            vehicleId,
            employeeId: nextDriver,
            type: 'principal',
            reason: 'Permiso requerido',
          },
        })
      ).status,
    ).toBe(403);

    const race = await Promise.all([
      fleet.adminA.post(ASSIGNMENTS, {
        json: {
          vehicleId,
          employeeId: nextDriver,
          type: 'principal',
          replace: true,
          reason: 'Relevo concurrente A',
        },
      }),
      fleet.adminA2.post(ASSIGNMENTS, {
        json: {
          vehicleId,
          employeeId: raceDriver,
          type: 'principal',
          replace: true,
          reason: 'Relevo concurrente B',
        },
      }),
    ]);
    expect(race.map((reply) => reply.status).sort()).toEqual([201, 409]);

    const current = await fleet.adminA.get(`${ASSIGNMENTS}?vehicleId=${vehicleId}&status=current`);
    expect(current.status).toBe(200);
    expect(current.json.total).toBe(1);
    const rows = await database.rows<{
      current_flag: number | null;
      employee_id: string;
      version: number;
    }>(
      'SELECT current_flag, employee_id, version FROM opslog_vehicle_assignments WHERE company_id = ? AND vehicle_id = ? ORDER BY started_at',
      [fleet.tenantA, vehicleId],
    );
    expect(rows.filter(({ current_flag }) => current_flag === 1)).toHaveLength(1);
    expect(rows.some(({ employee_id }) => employee_id === expiredDriver)).toBe(true);
    const historyByDriver = await fleet.adminA.get(`${ASSIGNMENTS}?employeeId=${expiredDriver}`);
    expect(historyByDriver.json.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: oldId, current: false })]),
    );
    const events = await database.rows<{ kind: string }>(
      'SELECT e.kind FROM opslog_vehicle_assignment_events e JOIN opslog_vehicle_assignments a ON a.id = e.assignment_id AND a.company_id = e.company_id WHERE a.company_id = ? AND a.vehicle_id = ? ORDER BY e.seq',
      [fleet.tenantA, vehicleId],
    );
    expect(events.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(['assigned', 'replaced']),
    );
    expect(rows.every(({ version }) => version >= 1)).toBe(true);
    const loser = race.find(({ status }) => status === 409);
    expect(['principal_taken', 'stale_version']).toContain(loser?.json.code);
    expect(loser?.text).not.toContain(nextDriver);
    expect(loser?.text).not.toContain(raceDriver);

    const occupied = await fleet.adminA.post(ASSIGNMENTS, {
      json: {
        vehicleId,
        employeeId: raceDriver,
        type: 'principal',
        reason: 'No desplazar titular vigente',
      },
    });
    expect(occupied.status).toBe(409);
    expect(occupied.json.code).toBe('principal_taken');
    expect(occupied.text).not.toContain(raceDriver);
  }, 60_000);
});
