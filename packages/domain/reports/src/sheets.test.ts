import { describe, expect, it } from 'vitest';
import { ReportError } from './errors.js';
import { ALL, MemorySources, READER, companyA, companyB, runReport } from './test-support.js';

const FLEET = [...READER, 'incidents:view'] as const;
const text = (rows: readonly { readonly [k: string]: unknown }[]) =>
  rows.map((r) => `${r['section']} | ${r['field']} | ${r['value']}`);

describe('sheets need the record they describe', () => {
  it('refuse a request without it and give nothing for an unknown or foreign record', async () => {
    for (const id of ['vehicle_sheet', 'driver_sheet', 'incident_sheet'])
      await expect(runReport(id, ALL)).rejects.toThrow(ReportError);
    const cases = [
      ['vehicle_sheet', { vehicle: 'nope' }],
      ['driver_sheet', { employee: 'nope' }],
      ['incident_sheet', { folio: 'nope' }],
    ] as const;
    for (const [id, filters] of cases)
      expect((await runReport(id, ALL, { filters })).rows).toEqual([]);
    expect(
      (await runReport('vehicle_sheet', ALL, { filters: { vehicle: 'ECO-1' } }, 'B')).rows,
    ).toEqual([]);
    expect(
      (await runReport('driver_sheet', ALL, { filters: { employee: 'E-01' } }, 'B')).rows,
    ).toEqual([]);
    expect(
      (await runReport('incident_sheet', ALL, { filters: { folio: 'SIN-2026-0001' } }, 'B')).rows,
    ).toEqual([]);
  });
});

describe('report vehicle_sheet', () => {
  const sheet = (permissions: readonly string[], key = 'ECO-1', sources?: MemorySources) =>
    runReport('vehicle_sheet', permissions as never, { filters: { vehicle: key } }, 'A', sources);

  it('gathers identification, drivers, documents, policies, recent work and cases in order', async () => {
    const { rows } = await sheet(FLEET);
    const lines = text(rows);
    expect(lines).toContain('Identificación | Nº económico | ECO-1');
    expect(lines).toContain('Identificación | Marca y modelo | Kenworth T680');
    expect(lines).toContain('Identificación | Estado | En mantenimiento');
    expect(lines).toContain('Identificación | Kilometraje (km) | 1,000');
    expect(lines).toContain('Conductores asignados | 1 | principal: Ana Zúñiga');
    expect(
      lines.some((l) =>
        l.startsWith('Documentos | 1 | Tarjeta de circulación TC-1: vence 2026-10-25 (Por vencer)'),
      ),
    ).toBe(true);
    expect(
      lines.some((l) =>
        l.startsWith('Seguros | 1 | Qualitas Q-100, Cobertura amplia, 2026-01-01 a 2026-11-30'),
      ),
    ).toBe(true);
    expect(lines.filter((l) => l.startsWith('Mantenimiento reciente'))).toHaveLength(4);
    expect(lines).toContain(
      'Siniestros (2) | 1 | SIN-2026-0003, 2026-10-10: Daño en estacionamiento, Reportado',
    );
    const numbered = await runReport(
      'vehicle_sheet',
      FLEET,
      { filters: { vehicle: 'ECO-1' }, columns: ['order', 'value'] },
      'A',
    );
    expect(numbered.rows.map((r) => r['order'])).toEqual(rows.map((_, i) => i + 1));
    expect(rows.every((r) => typeof r['value'] === 'string')).toBe(true);
  });

  it('adds the deductible, the cost of the orders and of the cases only for the readers of each', async () => {
    const plain = JSON.stringify((await sheet(FLEET)).rows);
    expect(plain).not.toMatch(/deducible|MXN|USD/);
    const fleetCosts = JSON.stringify((await sheet([...FLEET, 'view_costs'])).rows);
    expect(fleetCosts).toContain('deducible MXN 15000.50');
    expect(fleetCosts).toContain('MXN 3000.00; USD 1000.00');
    expect(fleetCosts).not.toContain('a cargo');
    const caseCosts = JSON.stringify((await sheet([...FLEET, 'incidents:view_costs'])).rows);
    expect(caseCosts).toContain('a cargo MXN 16500.00; USD 1000.00');
    expect(caseCosts).not.toContain('deducible');
  });

  it('prints «—» for what is not recorded and says so when a list is empty', async () => {
    const { rows } = await sheet(READER, 'ECO-3');
    const lines = text(rows);
    expect(lines).toContain('Identificación | VIN | —');
    expect(lines).toContain('Conductores asignados | Registros | Sin registros');
    expect(lines).toContain('Seguros | Registros | Sin registros');
  });
});

describe('report driver_sheet', () => {
  const sheet = (permissions: readonly string[], sources?: MemorySources) =>
    runReport(
      'driver_sheet',
      permissions as never,
      { filters: { employee: 'e-01' } },
      'A',
      sources,
    );

  it('gathers the person, the license, the vehicles, the documents and the cases', async () => {
    const lines = text((await sheet(FLEET)).rows);
    expect(lines).toContain('Identificación | Nombre | Ana Zúñiga');
    expect(lines).toContain('Identificación | Estatus | Activo');
    expect(lines).toContain('Licencia | Tipo | federal');
    expect(lines).toContain('Licencia | Días restantes | 13');
    expect(lines).toContain('Vehículos asignados | 1 | ECO-1 (PLA-100), principal');
    expect(lines).toContain('Vehículos asignados | 2 | ECO-2 (PLA-200), secondary');
    expect(
      lines.some((l) =>
        l.startsWith('Documentos | 1 | Examen médico M-1: vence 2026-10-19 (Por vencer)'),
      ),
    ).toBe(true);
    expect(lines).toContain(
      'Siniestros (2) | 2 | SIN-2026-0001, 2026-09-08: Colisión, En reparación',
    );
  });

  it('shows the license number only to a reader of personal data and reads it for this person only', async () => {
    const sources = new MemorySources({ A: companyA(), B: companyB() });
    const plain = text((await sheet(FLEET, sources)).rows);
    expect(plain.join('\n')).not.toContain('LIC-ANA-001');
    expect(sources.piiReads).toEqual([]);
    const full = text((await sheet([...FLEET, 'view_pii'], sources)).rows);
    expect(full).toContain('Licencia | Nº de licencia | LIC-ANA-001');
    expect(sources.piiReads).toHaveLength(1);
    expect(full.join('\n')).not.toContain('LIC-BETO');
  });
});

describe('report incident_sheet', () => {
  const sheet = (permissions: readonly string[], folio = 'sin-2026-0002') =>
    runReport('incident_sheet', permissions as never, { filters: { folio } });

  it('needs the permission of incidents and gathers the case, its SLA and follow-up', async () => {
    await expect(sheet(READER)).rejects.toThrow(ReportError);
    const lines = text((await sheet(['incidents:view'])).rows);
    expect(lines).toContain('Siniestro | Folio | SIN-2026-0002');
    expect(lines).toContain('Siniestro | Tipo | Robo total');
    expect(lines).toContain('Siniestro | Reaperturas | 1');
    expect(lines).toContain('Siniestro | Pérdida total | Sí');
    expect(lines).toContain('Evento | Vehículo | ECO-2 (PLA-200)');
    expect(lines).toContain('Evento | Conductor | Beto Álvarez');
    expect(lines).toContain('Cobertura | Cobertura | Con cobertura');
    expect(lines).toContain('Seguimiento | Resuelto | 2026-08-28');
    expect(lines).toContain('Plazo | Estado del plazo | Cumplido');
    expect(lines).toContain('Plazo | Plazo objetivo (días) | 7');
    expect(lines.some((l) => l.startsWith('Costos'))).toBe(false);
  });

  it('adds the costs of the case, per currency, only for a reader of case costs', async () => {
    const lines = text(
      (await sheet(['incidents:view', 'incidents:view_costs'], 'SIN-2026-0001')).rows,
    );
    expect(lines).toContain('Costos en MXN | Reparaciones (órdenes vinculadas) | 3000.00');
    expect(lines).toContain('Costos en MXN | A cargo de la empresa | 16500.00');
    expect(lines).toContain('Costos en USD | A cargo de la empresa | 1000.00');
  });
});
