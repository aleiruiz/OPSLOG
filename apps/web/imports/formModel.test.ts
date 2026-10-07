import { describe, expect, it } from 'vitest';
import { fileSignatureOf, inspect, signatureOf, toInput, validate, type ImportFormValues } from './formModel';
import { MAX_CSV_LENGTH } from './rules';

const vehicleHeader = 'economicNumber,plate,make,model,year,areaId,odometerKm';
const vehicleRow = 'ECO-9,ABC-9,Nissan,NP300,2022,area-norte,100';
const values = (csv: string, extra: Partial<ImportFormValues> = {}): ImportFormValues => ({
  entity: 'vehicle',
  mode: 'dry_run',
  csv,
  ...extra,
});
const ctx = { canViewPii: false };
const errorOf = (csv: string, extra: Partial<ImportFormValues> = {}, canViewPii = false) =>
  validate(values(csv, extra), { canViewPii }).csv;

describe('import file rules', () => {
  it('accepts a complete file', () => {
    expect(validate(values(`${vehicleHeader}\n${vehicleRow}`), ctx)).toEqual({});
  });

  it('explains an empty, oversized or unreadable file', () => {
    expect(errorOf('  ')).toBe('Pega las filas o carga un archivo CSV.');
    expect(errorOf('a'.repeat(MAX_CSV_LENGTH + 1))).toMatch(/Divídelo en varios archivos/);
    expect(errorOf('a,"b')).toMatch(/revisa las comillas/);
  });

  it('explains header problems: too many, unknown, repeated and missing columns', () => {
    expect(errorOf(Array.from({ length: 17 }, (_, i) => `c${i}`).join(','))).toMatch(/más de 16 columnas/);
    expect(errorOf(`${vehicleHeader},color\n${vehicleRow},rojo`)).toMatch(/no están en la plantilla: color/);
    expect(errorOf(`${vehicleHeader},plate\n${vehicleRow},x`)).toMatch(/repite columnas: plate/);
    expect(errorOf('economicNumber,plate\nECO-9,ABC-9')).toMatch(/Faltan columnas obligatorias.*Marca \(make\)/);
  });

  it('explains row problems: none, too many and ragged', () => {
    expect(errorOf(vehicleHeader)).toMatch(/solo tiene el encabezado/);
    const many = [vehicleHeader, ...Array.from({ length: 501 }, () => vehicleRow)].join('\n');
    expect(errorOf(many)).toMatch(/501 filas y el máximo es 500/);
    expect(errorOf(`${vehicleHeader}\n${vehicleRow}\nsolo,dos`)).toBe(
      'La línea 3 no tiene el mismo número de celdas que el encabezado.',
    );
  });

  it('blocks personal-data columns of an employee file unless the role can view them', () => {
    const csv = 'kind,firstName,lastName,areaId,email\ndriver,Ana,Lopez,area-norte,a@ejemplo.test';
    expect(errorOf(csv, { entity: 'employee' })).toMatch(/datos personales \(Correo \(email\)\)/);
    expect(errorOf(csv, { entity: 'employee' }, true)).toBeUndefined();
    // The same column in a vehicle file is simply unknown.
    expect(errorOf(csv)).toMatch(/no están en la plantilla/);
  });

  it('rejects an unknown entity or mode', () => {
    expect(validate({ ...values(''), entity: 'x' as never }, ctx).entity).toBeDefined();
    expect(validate({ ...values(vehicleHeader), mode: 'x' as never }, ctx).mode).toBeDefined();
  });

  it('inspects a file without sending it anywhere', () => {
    expect(inspect(`${vehicleHeader}\n${vehicleRow}`, 'vehicle')).toMatchObject({
      readable: true,
      rows: 1,
      raggedLine: null,
      pii: [],
    });
    expect(inspect('a,"b', 'vehicle').readable).toBe(false);
    expect(inspect('', 'vehicle')).toMatchObject({ readable: true, rows: 0, columns: [] });
  });

  it('sends the key and the validation id only on a commit', () => {
    const csv = `${vehicleHeader}\n${vehicleRow}`;
    expect(toInput(values(csv), { idempotencyKey: 'k-12345678', dryRunJobId: 'imp-1' })).toEqual({
      entity: 'vehicle',
      mode: 'dry_run',
      csv,
    });
    expect(toInput(values(csv, { mode: 'commit_all' }), { idempotencyKey: 'k-12345678', dryRunJobId: 'imp-1' })).toEqual({
      entity: 'vehicle',
      mode: 'commit_all',
      csv,
      idempotencyKey: 'k-12345678',
      dryRunJobId: 'imp-1',
    });
    expect(toInput(values(csv, { mode: 'commit_valid' }))).toEqual({ entity: 'vehicle', mode: 'commit_valid', csv });
  });

  it('tells apart requests and files by their signature', () => {
    const a = values('x');
    expect(signatureOf(a)).toBe(signatureOf({ ...a }));
    expect(signatureOf(a)).not.toBe(signatureOf({ ...a, mode: 'commit_all' }));
    expect(signatureOf(a)).not.toBe(signatureOf(a, 'imp-1'));
    expect(fileSignatureOf(a)).toBe(fileSignatureOf({ ...a, mode: 'commit_all' }));
    expect(fileSignatureOf(a)).not.toBe(fileSignatureOf({ ...a, entity: 'employee' }));
  });
});
