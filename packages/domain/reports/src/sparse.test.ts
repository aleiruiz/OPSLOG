import { describe, expect, it } from 'vitest';
import type { OpsData } from './test-support/ops.js';
import { MemorySources, READER, companyA, runReport } from './test-support.js';

const CASES = [...READER, 'incidents:view', 'view_costs', 'incidents:view_costs'] as const;

/** Company A with the gaps real data has: unknown ids, missing dates and plans, cases with nothing filled in. */
function sparse() {
  const data = companyA();
  const incident = (id: string, extra: Record<string, unknown>) =>
    ({
      id,
      folio: `SIN-X-${id}`,
      type: 'other',
      severity: null,
      status: 'reported',
      cycle: 1,
      reopenCount: 0,
      vehicleId: 'ghost',
      driverId: 'ghost-driver',
      areaId: 'zz',
      occurredOn: null,
      reportedAt: null,
      resolvedAt: null,
      closedAt: null,
      totalLoss: null,
      coverageStatus: 'unknown',
      ...extra,
    }) as OpsData['incidents'][number];
  data.incidents.push(
    incident('x1', {}),
    incident('x2', { occurredOn: '2026-10-01', vehicleId: 'v1', driverId: null, areaId: 'a1' }),
    incident('x3', { vehicleId: 'v1', areaId: 'a1' }),
    incident('x4', {
      severity: 'low',
      reportedAt: '2026-06-01T10:00:00.000Z',
      vehicleId: 'v1',
      areaId: 'a1',
    }),
  );
  data.incidentCosts['x1'] = [
    {
      currency: 'MXN',
      repairs: '0',
      expensesByCategory: {},
      expenses: '0',
      recoveries: '0',
      companyBorne: '0',
    },
  ];
  data.incidentSteps['x3'] = [
    { command: 'resolve', to: 'resolved', at: '2026-06-02T10:00:00.000Z' },
  ];
  data.incidentSteps['x4'] = [
    { command: 'report', to: 'reported', at: '2026-06-01T10:00:00.000Z' },
    { command: 'other', to: 'zzz', at: '2026-06-01T11:00:00.000Z' },
    { command: 'resolve', to: 'resolved', at: '2026-06-02T10:00:00.000Z' },
  ];
  data.incidentSla['x4'] = {
    state: 'met',
    cycle: 2,
    startedAt: null,
    deadline: null,
    targetDays: null,
    resolvedAt: null,
    previousCycles: [],
  };
  const order = (id: string, extra: Record<string, unknown>) =>
    ({
      id,
      kind: 'preventive',
      vehicleId: 'v1',
      planId: null,
      status: 'closed',
      description: null,
      workshop: null,
      scheduledDate: null,
      actualDate: null,
      actualKm: null,
      targetDate: null,
      targetKm: null,
      createdAt: '2026-09-25T15:00:00.000Z',
      closedAt: null,
      reopenCount: 0,
      incidentFolio: null,
      ...extra,
    }) as OpsData['workOrders'][number];
  data.workOrders.push(
    order('o1', { planId: 'ghost-plan', actualDate: '2026-09-20' }),
    order('o2', { planId: 'pl3', status: 'scheduled' }),
    order('o3', { planId: 'pl1', vehicleId: 'ghost' }),
    order('o4', { kind: 'corrective', vehicleId: 'ghost' }),
    order('o5', { kind: 'corrective', status: 'closed' }),
    order('o6', {
      status: 'completed',
      closedAt: '2026-09-21T15:00:00.000Z',
      costs: [{ category: 'other', amountMinor: '1000', currency: 'MXN' }],
    }),
    order('o7', {
      status: 'completed',
      costs: [{ category: 'other', amountMinor: '500', currency: 'MXN' }],
    }),
    order('o8', {
      vehicleId: 'ghost',
      status: 'completed',
      costs: [{ category: 'labor', amountMinor: '900', currency: 'MXN' }],
    }),
  );
  data.vehicles.push({
    ...data.vehicles[0],
    id: 'v4',
    economicNumber: 'ECO-4',
    plate: 'PLA-400',
    areaId: 'zz',
  } as (typeof data.vehicles)[number]);
  data.policies.push({
    id: 'p5',
    vehicleId: 'v1',
    insurer: 'Mapfre',
    policyNumber: 'M-5',
    coverageType: 'other',
    startsOn: '2026-02-01',
    endsOn: '2027-02-01',
    deductible: { kind: 'percent', basisPoints: 1250 },
  });
  data.assignmentHistory.push({
    vehicleId: 'v1',
    employeeId: 'ghost',
    type: 'temporary',
    startedAt: '2026-01-02T15:00:00.000Z',
    endedAt: null,
  });
  data.people.push({
    id: 'd4',
    kind: 'driver',
    firstName: 'Dora',
    lastName: 'Vega',
    employeeNumber: 'E-04',
    position: null,
    hireDate: null,
    areaId: 'a1',
    status: 'active',
    licenseType: null,
    licenseExpiresOn: null,
  });
  return new MemorySources({ A: data });
}

const col = (rows: readonly { readonly [k: string]: unknown }[], key: string) =>
  rows.map((r) => r[key]);

describe('reports over incomplete data', () => {
  it('plan vs. actual leaves out orders without a plan or a vehicle and names what is missing', async () => {
    const { rows } = await runReport('maintenance_plan_vs_actual', CASES, {}, 'A', sparse());
    expect(rows.find((r) => r['punctuality'] === 'Sin fecha objetivo')).toMatchObject({
      plan: null,
      actualDate: '2026-09-20',
      deviationDays: null,
    });
  });

  it('corrective, costs and frequency skip unknown vehicles and tolerate missing dates and areas', async () => {
    const sources = sparse();
    const corrective = await runReport('maintenance_corrective', CASES, {}, 'A', sources);
    expect(corrective.rows.some((r) => r['vehicle'] === null)).toBe(false);
    expect(
      corrective.rows.find((r) => r['description'] === null && r['status'] === 'Cerrada'),
    ).toMatchObject({
      closedOn: null,
      workDate: null,
    });
    const costs = await runReport('maintenance_costs', CASES, {}, 'A', sources);
    expect(
      costs.rows.find((r) => r['vehicle'] === 'ECO-1 (PLA-100)' && r['currency'] === 'MXN'),
    ).toMatchObject({
      other: 15,
    });
    expect(costs.rows.some((r) => r['total'] === 9)).toBe(false);
    // An order with no day at all is out of any period.
    const inSeptember = await runReport(
      'maintenance_costs',
      CASES,
      { filters: { from: '2026-09-01', to: '2026-09-30' } },
      'A',
      sources,
    );
    expect(inSeptember.rows.find((r) => r['currency'] === 'MXN')?.['other']).toBe(10);
    const frequency = await runReport('maintenance_frequency', CASES, {}, 'A', sources);
    expect(frequency.rows.find((r) => r['vehicle'] === 'ECO-4 (PLA-400)')).toMatchObject({
      area: null,
      orders: 0,
    });
  });

  it('incident reports name unknown vehicles, drivers and areas instead of failing', async () => {
    const sources = sparse();
    const period = await runReport('incidents_by_period', CASES, {}, 'A', sources);
    expect(col(period.rows, 'period')).toContain('Sin fecha');
    const subject = await runReport('incidents_by_subject', CASES, {}, 'A', sources);
    expect(col(subject.rows, 'subject')).toContain('Vehículo no disponible');
    expect(subject.rows.find((r) => r['subject'] === 'Vehículo no disponible')).toMatchObject({
      lastOn: null,
    });
    const costs = await runReport(
      'incident_costs',
      CASES,
      { filters: { status: 'reported' } },
      'A',
      sources,
    );
    expect(costs.rows[0]).toMatchObject({ vehicle: null, severity: null, companyBorne: 0 });
    const aging = await runReport('incident_aging', CASES, {}, 'A', sources);
    expect(aging.rows.find((r) => r['folio'] === 'SIN-X-x1')).toMatchObject({
      reportedOn: null,
      ageDays: null,
      bucket: null,
      slaState: null,
      deadline: null,
      daysToDeadline: null,
      vehicle: null,
      area: null,
    });
    expect(aging.rows.find((r) => r['folio'] === 'SIN-X-x2')).toMatchObject({
      reportedOn: '2026-10-01',
      ageDays: 18,
    });
  });

  it('resolution ignores cycles that never started, unknown stages and SLA that cannot be judged', async () => {
    const { rows } = await runReport(
      'incident_resolution',
      CASES,
      { filters: { severity: 'low' } },
      'A',
      sparse(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      severity: 'Baja',
      cycles: 1,
      slaMetPct: null,
      daysReported: 0.0,
    });
    const unrated = await runReport('incident_resolution', CASES, {}, 'A', sparse());
    expect(unrated.rows.some((r) => r['severity'] === 'Sin severidad')).toBe(false);
  });

  it('history and sheets keep going when a driver, plan or date is missing', async () => {
    const sources = sparse();
    const history = await runReport(
      'vehicle_history',
      CASES,
      { filters: { vehicle: 'ECO-1' } },
      'A',
      sources,
    );
    expect(col(history.rows, 'detail')).toContain('Temporal: Conductor no disponible');
    const vehicle = await runReport(
      'vehicle_sheet',
      CASES,
      { filters: { vehicle: 'ECO-1' } },
      'A',
      sources,
    );
    const lines = vehicle.rows.map((r) => `${r['field']} ${r['value']}`).join('\n');
    expect(lines).toContain('deducible 12.5 %');
    const driver = await runReport(
      'driver_sheet',
      CASES,
      { filters: { employee: 'E-04' } },
      'A',
      sources,
    );
    const text = driver.rows.map((r) => `${r['section']}|${r['field']}|${r['value']}`);
    expect(text).toContain('Licencia|Vigencia|—');
    expect(text).toContain('Licencia|Días restantes|—');
    expect(text).toContain('Documentos|Registros|Sin registros');
    expect(text).toContain('Vehículos asignados|Registros|Sin registros');
    expect(text).toContain('Siniestros (0)|Registros|Sin registros');
    const unknown = await runReport(
      'incident_sheet',
      CASES,
      { filters: { folio: 'SIN-X-x1' } },
      'A',
      sources,
    );
    const fields = unknown.rows.map((r) => `${r['section']}|${r['field']}|${r['value']}`);
    expect(fields).toContain('Evento|Vehículo|—');
    expect(fields).toContain('Evento|Conductor|—');
    expect(fields).toContain('Siniestro|Severidad|—');
    expect(fields).toContain('Siniestro|Pérdida total|—');
    expect(fields).toContain('Plazo|Estado del plazo|—');
    expect(fields).toContain('Costos en MXN|A cargo de la empresa|0.00');
  });

  it('expirations print an unknown area as empty', async () => {
    const data = companyA();
    data.areas = data.areas.filter((a) => a.id !== 'a1');
    const { rows } = await runReport(
      'expirations',
      READER,
      { filters: { category: 'vehicleDocument' } },
      'A',
      new MemorySources({ A: data }),
    );
    expect(rows.some((r) => r['area'] === null)).toBe(true);
  });
});
