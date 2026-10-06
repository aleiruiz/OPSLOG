import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEASE_MS,
  IMPORT_COLUMNS,
  ImportError,
  ImportService,
  InMemoryImportStore,
  MAX_CSV_LENGTH,
  MAX_ROWS,
  fingerprintOf,
  importWritesPii,
  isFormula,
  isImportEntity,
  isImportMode,
  isImportStatus,
  isRowIssueCode,
  isRowOutcome,
  parseCsv,
  parseSubmission,
  prepareRow,
  type CreateOutcome,
  type ImportEntity,
  type ImportEvent,
  type ImportJob,
  type ImportObserver,
  type ImportStore,
  type ImportTarget,
  type RowIssue,
} from './index.js';

const A = 'tenant-a';
const B = 'tenant-b';
const ACTOR = 'user-11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-10-06T12:00:00.000Z');

const vehicleRow = (n: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  economicNumber: `U-${n}`,
  plate: `ABC${n}`,
  make: 'Toyota',
  model: 'Hilux',
  year: '2022',
  areaId: 'area-1',
  odometerKm: '120',
  ...over,
});

const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return error instanceof ImportError ? error.code : 'other';
  }
  return 'none';
};
const codeOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return error instanceof ImportError ? error.code : 'other';
  }
  return 'none';
};

interface Spy {
  readonly target: ImportTarget;
  readonly created: string[];
  existing: Set<string>;
  failCreateOnce: boolean;
  rejectCreate: Set<string>;
  prechecks: number;
}

/** A fake vehicle target: plates are the natural key, year 1800 is invalid, area `gone` is inactive. */
function spy(): Spy {
  const state: Spy = {
    created: [],
    existing: new Set(),
    failCreateOnce: false,
    rejectCreate: new Set(),
    prechecks: 0,
    target: undefined as never,
  };
  const target: ImportTarget = {
    invalidColumns: (input) => (input['year'] === 1800 ? ['year'] : []),
    keys: (input) => [['plate', String(input['plate']).toLowerCase()]],
    precheck: async (_tenant, inputs) => {
      state.prechecks += 1;
      return inputs.map((input): RowIssue | null =>
        state.existing.has(String(input['plate']))
          ? { code: 'duplicate', columns: ['plate'] }
          : input['areaId'] === 'gone'
            ? { code: 'invalid_area', columns: ['areaId'] }
            : null,
      );
    },
    create: async (_tenant, _actor, input): Promise<CreateOutcome> => {
      if (state.failCreateOnce) {
        state.failCreateOnce = false;
        throw new Error('store down');
      }
      if (state.rejectCreate.has(String(input['plate'])))
        return { issue: { code: 'duplicate', columns: ['plate'] } };
      const id = `veh-${state.created.length + 1}`;
      state.created.push(id);
      return { id };
    },
  };
  return Object.assign(state, { target });
}

function setup(store: ImportStore = new InMemoryImportStore()) {
  const s = spy();
  let ids = 0;
  const clock = { now: NOW };
  const service = new ImportService(store, {
    targets: { vehicle: s.target, employee: s.target },
    now: () => clock.now,
    newId: () => `job-${(ids += 1)}`,
  });
  const later = (ms: number) => {
    clock.now = new Date(clock.now.getTime() + ms);
  };
  return { s, service, store, later };
}

describe('enumerations and guards', () => {
  it('recognize their members only', () => {
    expect(isImportEntity('vehicle')).toBe(true);
    expect(isImportEntity('area')).toBe(false);
    expect(isImportMode('dry_run')).toBe(true);
    expect(isImportMode('commit')).toBe(false);
    expect(isImportStatus('running')).toBe(true);
    expect(isImportStatus(1)).toBe(false);
    expect(isRowOutcome('skipped')).toBe(true);
    expect(isRowOutcome('ok')).toBe(false);
    expect(isRowIssueCode('duplicate')).toBe(true);
    expect(isRowIssueCode('nope')).toBe(false);
    expect(new ImportError('conflict').message).toBe('Import request rejected: conflict');
  });
});

describe('parseCsv', () => {
  it('reads quoted cells, escaped quotes, CRLF, a byte-order mark and skips blank lines', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\n1,\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['1', ''],
    ]);
    expect(parseCsv('a,b\rc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(parseCsv('a,"b\nc"')).toEqual([['a', 'b\nc']]);
    expect(parseCsv('a,""')).toEqual([['a', '']]);
    expect(parseCsv('')).toEqual([]);
  });

  it('rejects malformed text', () => {
    for (const text of ['a"b,c', '"a"b,c', '"unterminated', '"a"" ,b" x'])
      expect(codeOf(() => parseCsv(text))).toBe('invalid_input');
  });
});

describe('isFormula', () => {
  it('flags spreadsheet formula leads, except international phone numbers in `phone`', () => {
    for (const text of ['=1+1', '@SUM(A1)', '+cmd|x', '-2+3', '+52 55', '-1'])
      expect(isFormula('plate', text)).toBe(true);
    expect(isFormula('phone', '+52 55 1234 5678')).toBe(false);
    expect(isFormula('phone', '+1+1')).toBe(true);
    expect(isFormula('phone', '=+525512345678')).toBe(true);
    expect(isFormula('plate', 'ABC-123')).toBe(false);
  });
});

describe('parseSubmission', () => {
  const rows = [vehicleRow(1)];
  const valid = { entity: 'vehicle', mode: 'dry_run', rows };

  it('accepts rows or csv and derives the columns', () => {
    const fromRows = parseSubmission(valid);
    expect(fromRows).toMatchObject({
      entity: 'vehicle',
      mode: 'dry_run',
      idempotencyKey: null,
      dryRunJobId: null,
    });
    expect(fromRows.columns).toContain('plate');
    const csv = 'economicNumber,plate,make,model,year,areaId,odometerKm\nU-1,ABC1,T,H,2022,a1,5\n';
    expect(parseSubmission({ entity: 'vehicle', mode: 'dry_run', csv }).rows).toEqual([
      {
        economicNumber: 'U-1',
        plate: 'ABC1',
        make: 'T',
        model: 'H',
        year: '2022',
        areaId: 'a1',
        odometerKm: '5',
      },
    ]);
    expect(
      parseSubmission({
        entity: 'vehicle',
        mode: 'commit_valid',
        idempotencyKey: 'key-12345678',
        dryRunJobId: 'job-1',
        rows,
      }),
    ).toMatchObject({ idempotencyKey: 'key-12345678', dryRunJobId: 'job-1' });
  });

  it('rejects every malformed request', () => {
    const csvHead = 'economicNumber,plate,make,model,year,areaId,odometerKm';
    const bad: unknown[] = [
      null,
      [],
      'text',
      { ...valid, extra: 1 },
      { mode: 'dry_run', rows },
      { entity: 'area', mode: 'dry_run', rows },
      { entity: 'vehicle', mode: 'sync', rows },
      { entity: 'vehicle', mode: 'dry_run' },
      { entity: 'vehicle', mode: 'dry_run', rows, csv: csvHead },
      { ...valid, mode: 'commit_all' },
      { ...valid, mode: 'commit_all', idempotencyKey: 'short' },
      { ...valid, mode: 'commit_all', idempotencyKey: 12345678 },
      { ...valid, idempotencyKey: 'bad key with spaces' },
      { ...valid, dryRunJobId: 'job-1' },
      { ...valid, mode: 'commit_all', idempotencyKey: 'key-12345678', dryRunJobId: '../x' },
      { ...valid, rows: 'nope' },
      { ...valid, rows: [] },
      { ...valid, rows: [null] },
      { ...valid, rows: [[]] },
      { ...valid, rows: [{ ...vehicleRow(1), color: 'red' }] },
      { ...valid, rows: [JSON.parse('{"__proto__": "x"}')] },
      { ...valid, rows: Array.from({ length: MAX_ROWS + 1 }, (_, i) => vehicleRow(i)) },
      { entity: 'vehicle', mode: 'dry_run', csv: 7 },
      { entity: 'vehicle', mode: 'dry_run', csv: 'x'.repeat(MAX_CSV_LENGTH + 1) },
      { entity: 'vehicle', mode: 'dry_run', csv: '' },
      { entity: 'vehicle', mode: 'dry_run', csv: `${csvHead}` },
      { entity: 'vehicle', mode: 'dry_run', csv: `plate,plate\nA,B` },
      { entity: 'vehicle', mode: 'dry_run', csv: `${csvHead},color\n1,2,3,4,5,6,7,8` },
      { entity: 'vehicle', mode: 'dry_run', csv: 'plate,make\nA,B' },
      { entity: 'vehicle', mode: 'dry_run', csv: `${csvHead}\n1,2` },
      { entity: 'vehicle', mode: 'dry_run', csv: `${Array(17).fill('plate').join(',')}\n1` },
    ];
    for (const input of bad)
      expect([input, codeOf(() => parseSubmission(input))]).toEqual([input, 'invalid_input']);
  });

  it('detects personal data columns', () => {
    const employee = (extra: Record<string, unknown>) => ({
      entity: 'employee',
      mode: 'dry_run',
      rows: [{ kind: 'driver', firstName: 'Ana', lastName: 'Perez', areaId: 'a1', ...extra }],
    });
    expect(importWritesPii(employee({}))).toBe(false);
    expect(importWritesPii(employee({ email: 'ana@synthetic.example' }))).toBe(true);
    expect(importWritesPii(employee({ position: 'Chofer' }))).toBe(false);
    expect(importWritesPii({ nonsense: true })).toBe(false);
    expect(IMPORT_COLUMNS.vehicle.pii).toEqual([]);
  });
});

describe('prepareRow', () => {
  const prep = (raw: Record<string, unknown>) => prepareRow('vehicle', 7, raw);

  it('builds the create request: trimmed cells, empty cells absent, integers read', () => {
    expect(
      prep({ ...vehicleRow(1), plate: '  ABC1 ', vin: '', registeredOn: null, year: 2022 }),
    ).toEqual({
      rowNumber: 7,
      issue: null,
      input: {
        economicNumber: 'U-1',
        plate: 'ABC1',
        make: 'Toyota',
        model: 'Hilux',
        year: 2022,
        areaId: 'area-1',
        odometerKm: 120,
      },
    });
  });

  it('names the columns at fault without echoing values', () => {
    expect(prep(vehicleRow(1, { plate: '=cmd|x', make: '@x' })).issue).toEqual({
      code: 'formula_injection',
      columns: ['plate', 'make'],
    });
    const { plate, areaId, ...partial } = vehicleRow(1);
    expect([plate, areaId]).toHaveLength(2);
    expect(prep(partial).issue).toEqual({ code: 'missing_value', columns: ['plate', 'areaId'] });
    expect(prep(vehicleRow(1, { plate: '   ' })).issue).toEqual({
      code: 'missing_value',
      columns: ['plate'],
    });
    expect(prep(vehicleRow(1, { year: '20x2', odometerKm: '-1' })).issue?.code).toBe(
      'formula_injection',
    );
    expect(prep(vehicleRow(1, { year: '20x2' })).issue).toEqual({
      code: 'invalid_value',
      columns: ['year'],
    });
    expect(prep(vehicleRow(1, { odometerKm: '12345678' })).issue?.code).toBe('invalid_value');
    expect(prep(vehicleRow(1, { make: 'x'.repeat(201) })).issue).toEqual({
      code: 'invalid_value',
      columns: ['make'],
    });
    expect(prep(vehicleRow(1, { make: true })).issue?.code).toBe('invalid_value');
    expect(prep(vehicleRow(1, { year: -4 })).issue?.code).toBe('invalid_value');
    expect(prep(vehicleRow(1, { year: 20.5 })).issue?.code).toBe('invalid_value');
    expect(prep(vehicleRow(1, { make: {} })).issue?.code).toBe('invalid_value');
    // An unreadable required cell is invalid, not missing.
    expect(prep(vehicleRow(1, { plate: 'x'.repeat(201) })).issue).toEqual({
      code: 'invalid_value',
      columns: ['plate'],
    });
  });

  it('accepts an international phone in an employee row', () => {
    const row = {
      kind: 'driver',
      firstName: 'Ana',
      lastName: 'Perez',
      areaId: 'a1',
      phone: '+52 55 0000 1111',
    };
    expect(prepareRow('employee', 1, row).issue).toBeNull();
    expect(prepareRow('employee', 1, { ...row, email: '=x' }).issue?.code).toBe(
      'formula_injection',
    );
  });
});

describe('fingerprintOf', () => {
  it('is stable, ignores key order and cell padding, and never depends on personal data values', () => {
    const base = { entity: 'employee' as const, rows: [{ kind: 'driver', email: 'a@x.example' }] };
    expect(fingerprintOf(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf({ ...base, rows: [{ email: ' a@x.example ', kind: 'driver ' }] })).toBe(
      fingerprintOf(base),
    );
    // Another personal value, same presence: same fingerprint (values are not fingerprinted).
    expect(fingerprintOf({ ...base, rows: [{ kind: 'driver', email: 'other@x.example' }] })).toBe(
      fingerprintOf(base),
    );
    // Presence, a non-personal value and the entity all change it.
    expect(fingerprintOf({ ...base, rows: [{ kind: 'driver', email: '' }] })).not.toBe(
      fingerprintOf(base),
    );
    expect(fingerprintOf({ ...base, rows: [{ kind: 'other', email: 'a@x.example' }] })).not.toBe(
      fingerprintOf(base),
    );
    expect(fingerprintOf({ ...base, entity: 'vehicle' })).not.toBe(fingerprintOf(base));
    expect(fingerprintOf({ entity: 'vehicle', rows: [{ year: 2022, odometerKm: null }] })).toBe(
      fingerprintOf({ entity: 'vehicle', rows: [{ year: '2022', odometerKm: '' }] }),
    );
  });
});

describe('dry run', () => {
  it('validates every row, writes no vehicle and records the per-row report', async () => {
    const { s, service } = setup();
    s.existing.add('ABC3');
    const rows = [
      vehicleRow(1),
      vehicleRow(2, { plate: '=1+1' }),
      vehicleRow(3),
      vehicleRow(4, { year: '1800' }),
      vehicleRow(5, { plate: 'abc1' }),
      vehicleRow(6, { areaId: 'gone' }),
      vehicleRow(7, { make: '' }),
    ];
    const { job, replayed } = await service.submit(A, ACTOR, {
      entity: 'vehicle',
      mode: 'dry_run',
      rows,
    });
    expect(replayed).toBe(false);
    expect(s.created).toEqual([]);
    expect(job).toMatchObject({
      status: 'validated',
      mode: 'dry_run',
      totalRows: 7,
      validRows: 1,
      invalidRows: 6,
      importedRows: 0,
      version: 2,
      createdBy: ACTOR,
      idempotencyKey: null,
    });
    const report = await service.rows(A, job.id, { outcome: 'invalid' });
    expect(report.items.map((r) => [r.rowNumber, r.code, r.columns])).toEqual([
      [2, 'formula_injection', ['plate']],
      [3, 'duplicate', ['plate']],
      [4, 'invalid_value', ['year']],
      [5, 'duplicate_in_file', ['plate']],
      [6, 'invalid_area', ['areaId']],
      [7, 'missing_value', ['make']],
    ]);
    expect((await service.rows(A, job.id)).items[0]).toMatchObject({
      rowNumber: 1,
      outcome: 'valid',
      code: null,
      columns: [],
      entityId: null,
    });
    // No row result carries a submitted value.
    expect(JSON.stringify(await service.rows(A, job.id))).not.toMatch(/Toyota|Hilux|ABC/);
    expect((await service.history(A, job.id)).items.map((e) => [e.seq, e.kind])).toEqual([
      [2, 'validated'],
      [1, 'started'],
    ]);
  });
});

describe('commit modes', () => {
  const rows = [vehicleRow(1), vehicleRow(2, { year: '1800' }), vehicleRow(3)];

  it('commit_valid imports the valid rows once and reports the rest', async () => {
    const { s, service } = setup();
    const seen: string[] = [];
    const observer: ImportObserver = { created: (entity, id) => seen.push(`${entity}:${id}`) };
    const first = await service.submit(
      A,
      ACTOR,
      { entity: 'vehicle', mode: 'commit_valid', idempotencyKey: 'key-aaaaaaaa', rows },
      observer,
    );
    expect(first.job).toMatchObject({
      status: 'imported',
      validRows: 2,
      invalidRows: 1,
      importedRows: 2,
    });
    expect(seen).toEqual(['vehicle:veh-1', 'vehicle:veh-2']);
    const results = (await service.rows(A, first.job.id)).items;
    expect(results.map((r) => [r.rowNumber, r.outcome, r.entityId])).toEqual([
      [1, 'imported', 'veh-1'],
      [2, 'invalid', null],
      [3, 'imported', 'veh-2'],
    ]);
    // The same key and rows: the stored job, nothing runs again.
    const again = await service.submit(A, ACTOR, {
      entity: 'vehicle',
      mode: 'commit_valid',
      idempotencyKey: 'key-aaaaaaaa',
      rows,
    });
    expect(again).toMatchObject({ replayed: true, job: { id: first.job.id } });
    expect(s.created).toHaveLength(2);
    expect((await service.history(A, first.job.id)).total).toBe(2);
  });

  it('commit_all writes nothing while one row is invalid', async () => {
    const { s, service } = setup();
    const { job } = await service.submit(A, ACTOR, {
      entity: 'vehicle',
      mode: 'commit_all',
      idempotencyKey: 'key-bbbbbbbb',
      rows,
    });
    expect(s.created).toEqual([]);
    expect(job).toMatchObject({ status: 'failed', importedRows: 0, validRows: 2, invalidRows: 1 });
    expect((await service.rows(A, job.id)).items.map((r) => r.outcome)).toEqual([
      'skipped',
      'invalid',
      'skipped',
    ]);
    expect((await service.history(A, job.id)).items[0]).toMatchObject({
      kind: 'failed',
      acceptedRows: 0,
      rejectedRows: 1,
    });
  });

  it('commit_all imports everything when every row is valid', async () => {
    const { s, service } = setup();
    const { job } = await service.submit(A, ACTOR, {
      entity: 'vehicle',
      mode: 'commit_all',
      idempotencyKey: 'key-cccccccc',
      rows: [vehicleRow(1), vehicleRow(2)],
    });
    expect(job).toMatchObject({ status: 'imported', importedRows: 2, invalidRows: 0 });
    expect(s.created).toHaveLength(2);
  });

  it('reports a row the entity service refuses at write time as invalid', async () => {
    const { s, service } = setup();
    s.rejectCreate.add('ABC2');
    const { job } = await service.submit(A, ACTOR, {
      entity: 'vehicle',
      mode: 'commit_valid',
      idempotencyKey: 'key-dddddddd',
      rows: [vehicleRow(1), vehicleRow(2)],
    });
    expect(job).toMatchObject({ status: 'imported', importedRows: 1, invalidRows: 1 });
    expect((await service.rows(A, job.id, { outcome: 'invalid' })).items[0]).toMatchObject({
      rowNumber: 2,
      code: 'duplicate',
    });
  });

  it('is failed when nothing could be imported', async () => {
    const { service } = setup();
    const { job } = await service.submit(A, ACTOR, {
      entity: 'vehicle',
      mode: 'commit_valid',
      idempotencyKey: 'key-eeeeeeee',
      rows: [vehicleRow(1, { year: '1800' })],
    });
    expect(job).toMatchObject({ status: 'failed', importedRows: 0, validRows: 0, invalidRows: 1 });
  });

  it('resumes a job that stopped midway without creating anything twice', async () => {
    const { s, service, later } = setup();
    s.failCreateOnce = true;
    const input = {
      entity: 'vehicle',
      mode: 'commit_valid',
      idempotencyKey: 'key-ffffffff',
      rows: [vehicleRow(1), vehicleRow(2), vehicleRow(3)],
    };
    // The first create throws (outage): the job stays running.
    await expect(service.submit(A, ACTOR, input)).rejects.toThrow('store down');
    expect(s.created).toEqual([]);
    // Within the lease the first attempt may still be running: not ours to run twice.
    later(DEFAULT_LEASE_MS - 1);
    expect(await code(service.submit(A, ACTOR, input))).toBe('conflict');
    expect(s.created).toEqual([]);
    later(1);
    const resumed = await service.submit(A, ACTOR, input);
    expect(resumed).toMatchObject({
      replayed: false,
      job: { status: 'imported', importedRows: 3 },
    });
    expect(s.created).toHaveLength(3);
    // Stopped after one row: only the rest is created.
    const second = {
      ...input,
      idempotencyKey: 'key-gggggggg',
      rows: [vehicleRow(4), vehicleRow(5)],
    };
    let calls = 0;
    const original = s.target.create;
    (s.target as { create: ImportTarget['create'] }).create = async (t, a, i) => {
      calls += 1;
      if (calls === 2) throw new Error('crash');
      return original(t, a, i);
    };
    await expect(service.submit(A, ACTOR, second)).rejects.toThrow('crash');
    expect(s.created).toHaveLength(4);
    later(DEFAULT_LEASE_MS);
    (s.target as { create: ImportTarget['create'] }).create = original;
    const finished = await service.submit(A, ACTOR, second);
    expect(finished.job).toMatchObject({ status: 'imported', importedRows: 2 });
    expect(s.created).toHaveLength(5);
  });

  it('refuses a key reused for a different request or mode', async () => {
    const { service } = setup();
    const input = {
      entity: 'vehicle',
      mode: 'commit_valid',
      idempotencyKey: 'key-hhhhhhhh',
      rows: [vehicleRow(1)],
    };
    await service.submit(A, ACTOR, input);
    expect(await code(service.submit(A, ACTOR, { ...input, rows: [vehicleRow(2)] }))).toBe(
      'conflict',
    );
    expect(await code(service.submit(A, ACTOR, { ...input, mode: 'commit_all' }))).toBe('conflict');
    const employee = {
      entity: 'employee',
      mode: 'commit_valid',
      idempotencyKey: 'key-hhhhhhhh',
      rows: [{ kind: 'driver', firstName: 'Ana', lastName: 'Perez', areaId: 'a1' }],
    };
    expect(await code(service.submit(A, ACTOR, employee))).toBe('conflict');
    // Another tenant may use the same key.
    expect((await service.submit(B, ACTOR, input)).replayed).toBe(false);
  });

  it('treats a lost race for the key as the winner`s job, and a vanished winner as a conflict', async () => {
    const real = new InMemoryImportStore();
    const racing: ImportStore = {
      insertJob: real.insertJob.bind(real),
      findJob: real.findJob.bind(real),
      findByKey: real.findByKey.bind(real),
      listJobs: real.listJobs.bind(real),
      appendRows: real.appendRows.bind(real),
      rows: real.rows.bind(real),
      finishJob: real.finishJob.bind(real),
      events: real.events.bind(real),
    };
    const { service } = setup(racing);
    const input = {
      entity: 'vehicle',
      mode: 'dry_run',
      idempotencyKey: 'key-iiiiiiii',
      rows: [vehicleRow(1)],
    };
    // The key is not visible on the first lookup, but the insert loses to a concurrent attempt.
    const winner = await setup(real).service.submit(A, ACTOR, input);
    let lookups = 0;
    racing.findByKey = async (tenant, key) =>
      lookups++ === 0 ? null : real.findByKey(tenant, key);
    const lost = await service.submit(A, ACTOR, input);
    expect(lost).toMatchObject({ replayed: true, job: { id: winner.job.id } });
    racing.findByKey = async () => null;
    expect(await code(service.submit(A, ACTOR, input))).toBe('conflict');
    // Without a key, a refused insert (id collision) is a conflict too.
    racing.insertJob = async () => false;
    expect(
      await code(
        service.submit(A, ACTOR, { entity: 'vehicle', mode: 'dry_run', rows: [vehicleRow(1)] }),
      ),
    ).toBe('conflict');
  });

  it('returns the winner`s result when another attempt finished the job first', async () => {
    const real = new InMemoryImportStore();
    const store: ImportStore = Object.assign(Object.create(real) as ImportStore, {
      finishJob: async () => false,
    });
    const { service } = setup(store);
    const { job } = await service.submit(A, ACTOR, {
      entity: 'vehicle',
      mode: 'dry_run',
      rows: [vehicleRow(1)],
    });
    // The stored job is still the running one the store kept (nobody finished it): that is what is returned.
    expect(job.status).toBe('running');
    const vanished: ImportStore = Object.assign(
      Object.create(new InMemoryImportStore()) as ImportStore,
      {
        finishJob: async () => false,
        findJob: async () => null,
      },
    );
    const second = await setup(vanished).service.submit(A, ACTOR, {
      entity: 'vehicle',
      mode: 'dry_run',
      rows: [vehicleRow(1)],
    });
    expect(second.job.status).toBe('validated');
  });
});

describe('snapshot confirmation', () => {
  const rows = [vehicleRow(1), vehicleRow(2)];
  const dry = { entity: 'vehicle', mode: 'dry_run', rows };

  it('accepts the dry run it confirms and rejects anything else', async () => {
    const { service } = setup();
    const preview = (await service.submit(A, ACTOR, dry)).job;
    const commit = {
      entity: 'vehicle',
      mode: 'commit_all',
      idempotencyKey: 'key-jjjjjjjj',
      dryRunJobId: preview.id,
      rows,
    };
    expect(
      await code(service.submit(A, ACTOR, { ...commit, rows: [vehicleRow(1), vehicleRow(9)] })),
    ).toBe('conflict');
    expect(await code(service.submit(A, ACTOR, { ...commit, dryRunJobId: 'job-none' }))).toBe(
      'not_found',
    );
    // A dry run of another tenant is as unknown as a missing one.
    expect(await code(service.submit(B, ACTOR, commit))).toBe('not_found');
    expect((await service.submit(A, ACTOR, commit)).job.status).toBe('imported');
    // A commit job is not a dry run, and a dry run that has not validated yet is not a preview.
    const committed = (await service.list(A, { status: 'imported' })).items[0] as ImportJob;
    expect(
      await code(
        service.submit(A, ACTOR, {
          ...commit,
          idempotencyKey: 'key-kkkkkkkk',
          dryRunJobId: committed.id,
        }),
      ),
    ).toBe('conflict');
  });

  it('refuses a preview that is still running', async () => {
    const real = new InMemoryImportStore();
    const store: ImportStore = Object.assign(Object.create(real) as ImportStore, {
      finishJob: async () => false,
    });
    const { service } = setup(store);
    const running = (await service.submit(A, ACTOR, dry)).job;
    expect(
      await code(
        service.submit(A, ACTOR, {
          entity: 'vehicle',
          mode: 'commit_all',
          idempotencyKey: 'key-llllllll',
          dryRunJobId: running.id,
          rows,
        }),
      ),
    ).toBe('conflict');
  });
});

describe('reads', () => {
  it('lists, pages and filters jobs of the tenant only', async () => {
    const { service } = setup();
    const a1 = (
      await service.submit(A, ACTOR, { entity: 'vehicle', mode: 'dry_run', rows: [vehicleRow(1)] })
    ).job;
    const a2 = (
      await service.submit(A, ACTOR, {
        entity: 'employee',
        mode: 'commit_valid',
        idempotencyKey: 'key-mmmmmmmm',
        rows: [{ kind: 'driver', firstName: 'Ana', lastName: 'Perez', areaId: 'a1' }],
      })
    ).job;
    await service.submit(B, ACTOR, { entity: 'vehicle', mode: 'dry_run', rows: [vehicleRow(1)] });
    const all = await service.list(A);
    expect(all.total).toBe(2);
    expect(all.items.map((job) => job.id).sort()).toEqual([a1.id, a2.id].sort());
    expect((await service.list(A, { entity: 'employee' })).items.map((j) => j.id)).toEqual([a2.id]);
    expect((await service.list(A, { status: 'validated' })).items.map((j) => j.id)).toEqual([
      a1.id,
    ]);
    expect((await service.list(A, { limit: 1, offset: 1 })).items).toHaveLength(1);
    for (const query of [
      { entity: 'area' },
      { status: 'done' },
      { limit: 0 },
      { limit: 101 },
      { offset: -1 },
      { limit: '5' },
    ])
      expect(await code(service.list(A, query))).toBe('invalid_input');
  });

  it('answers not_found for a job of another tenant, uniformly', async () => {
    const { service } = setup();
    const job = (
      await service.submit(A, ACTOR, { entity: 'vehicle', mode: 'dry_run', rows: [vehicleRow(1)] })
    ).job;
    for (const read of [
      () => service.get(B, job.id),
      () => service.rows(B, job.id),
      () => service.history(B, job.id),
      () => service.get(A, 'missing'),
    ])
      expect(await code(read())).toBe('not_found');
    expect(await code(service.get(A, '../bad'))).toBe('invalid_input');
    expect((await service.get(A, job.id)).id).toBe(job.id);
    expect(await code(service.rows(A, job.id, { outcome: 'ok' }))).toBe('invalid_input');
    expect(await code(service.history(A, job.id, { limit: 0 }))).toBe('invalid_input');
    expect((await service.rows(A, job.id, { limit: 1 })).total).toBe(1);
  });

  it('validates the principals of a submission', async () => {
    const { service } = setup();
    const input = { entity: 'vehicle', mode: 'dry_run', rows: [vehicleRow(1)] };
    expect(await code(service.submit('', ACTOR, input))).toBe('invalid_input');
    expect(await code(service.submit(A, '', input))).toBe('invalid_input');
    expect(await code(service.submit(A, ACTOR, { ...input, mode: 'nope' }))).toBe('invalid_input');
    expect(await code(service.list('', {}))).toBe('invalid_input');
  });
});

describe('InMemoryImportStore', () => {
  const job = (tenant: string, id: string, key: string | null): ImportJob => ({
    id,
    tenantId: tenant,
    entity: 'vehicle' as ImportEntity,
    mode: 'commit_all',
    status: 'running',
    idempotencyKey: key,
    fingerprint: 'f'.repeat(64),
    totalRows: 1,
    validRows: 0,
    invalidRows: 0,
    importedRows: 0,
    createdBy: ACTOR,
    createdAt: NOW.toISOString(),
    finishedAt: null,
    version: 1,
    updatedAt: NOW.toISOString(),
  });
  const started = (j: ImportJob): ImportEvent => ({
    tenantId: j.tenantId,
    jobId: j.id,
    seq: 1,
    kind: 'started',
    actorId: ACTOR,
    acceptedRows: null,
    rejectedRows: null,
    at: j.createdAt,
  });

  it('keeps tenants and keys apart and never rewrites a recorded row', async () => {
    const store = new InMemoryImportStore();
    const j1 = job(A, 'j1', 'key-nnnnnnnn');
    expect(await store.insertJob(j1, started(j1))).toBe(true);
    expect(await store.insertJob(job(A, 'j2', 'key-nnnnnnnn'), started(j1))).toBe(false);
    expect(await store.insertJob(job(A, 'j1', null), started(j1))).toBe(false);
    const other = job(B, 'j1', 'key-nnnnnnnn');
    expect(await store.insertJob(other, started(other))).toBe(true);
    expect(await store.findByKey(A, 'key-oooooooo')).toBeNull();
    expect((await store.findByKey(B, 'key-nnnnnnnn'))?.tenantId).toBe(B);
    const row = (outcome: 'valid' | 'invalid') => ({
      tenantId: A,
      jobId: 'j1',
      rowNumber: 1,
      outcome,
      code: null,
      columns: [],
      entityId: null,
      at: NOW.toISOString(),
    });
    await store.appendRows(A, 'j1', [row('valid')]);
    await store.appendRows(A, 'j1', [row('invalid')]);
    expect((await store.rows(A, 'j1', {}, { limit: 5, offset: 0 })).items[0]?.outcome).toBe(
      'valid',
    );
    expect((await store.rows(B, 'j1', {}, { limit: 5, offset: 0 })).total).toBe(0);
    expect((await store.rows(A, 'j1', { outcome: 'invalid' }, { limit: 5, offset: 0 })).total).toBe(
      0,
    );
    expect(await store.finishJob({ ...j1, version: 2 }, 5, started(j1))).toBe(false);
    expect((await store.events(A, 'j1', { limit: 5, offset: 0 })).total).toBe(1);
    expect((await store.listJobs(A, {}, { limit: 5, offset: 0 })).total).toBe(1);
  });
});
