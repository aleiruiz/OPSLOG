import type { ImportEvent, ImportJob, ImportRow } from '../app/types';

/** Synthetic import jobs for the mock API, tests and stories. Nothing here is real data: a row never carries a cell. */

export function makeJob(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    id: 'imp-001',
    entity: 'vehicle',
    mode: 'commit_valid',
    status: 'imported',
    totalRows: 300,
    validRows: 288,
    invalidRows: 12,
    importedRows: 288,
    createdBy: 'user-admin',
    createdAt: '2026-10-05T16:20:00.000Z',
    finishedAt: '2026-10-05T16:20:04.000Z',
    version: 2,
    ...overrides,
  };
}

export function makeRow(overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    rowNumber: 1,
    outcome: 'imported',
    code: null,
    columns: [],
    entityId: 'veh-901',
    at: '2026-10-05T16:20:03.000Z',
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<ImportEvent> = {}): ImportEvent {
  return {
    seq: 1,
    kind: 'started',
    actorId: 'user-admin',
    acceptedRows: null,
    rejectedRows: null,
    at: '2026-10-05T16:20:00.000Z',
    ...overrides,
  };
}

/** The first rows of a commit with errors: a mix of every code the server reports and some imported rows. */
export function demoRows(count = 30): ImportRow[] {
  const failures: Pick<ImportRow, 'code' | 'columns'>[] = [
    { code: 'missing_value', columns: ['plate'] },
    { code: 'invalid_value', columns: ['year', 'odometerKm'] },
    { code: 'duplicate_in_file', columns: ['economicNumber'] },
    { code: 'duplicate', columns: ['plate'] },
    { code: 'invalid_area', columns: ['areaId'] },
    { code: 'formula_injection', columns: ['model'] },
  ];
  return Array.from({ length: count }, (_, index) => {
    const rowNumber = index + 1;
    if (rowNumber % 5 === 0) {
      const failure = failures[(rowNumber / 5 - 1) % failures.length] as (typeof failures)[number];
      return makeRow({ rowNumber, outcome: 'invalid', entityId: null, ...failure });
    }
    return makeRow({ rowNumber, entityId: `veh-${String(900 + rowNumber).padStart(3, '0')}` });
  });
}

export interface DemoImport {
  readonly job: ImportJob;
  readonly rows: readonly ImportRow[];
  readonly events: readonly ImportEvent[];
}

/**
 * Six jobs, newest first, with their reports: an imported commit with errors, a validation, a failed all-or-nothing
 * commit, an employee import, a clean import and one still running. A second page needs more than 25, so `count` jobs
 * are produced by repeating clean imports behind the first six.
 */
export function demoImports(count = 28): DemoImport[] {
  const rows = demoRows(30);
  const invalid = rows.filter((row) => row.outcome === 'invalid');
  const imported = rows.filter((row) => row.outcome === 'imported');
  const events = (job: ImportJob): ImportEvent[] => [
    makeEvent({ at: job.createdAt, actorId: job.createdBy }),
    ...(job.finishedAt === null
      ? []
      : [
          makeEvent({
            seq: 2,
            kind: job.status === 'validated' ? 'validated' : job.status === 'failed' ? 'failed' : 'imported',
            acceptedRows: job.validRows,
            rejectedRows: job.invalidRows,
            at: job.finishedAt,
            actorId: job.createdBy,
          }),
        ]),
  ];
  const curated: DemoImport[] = [
    { job: makeJob(), rows, events: [] },
    {
      job: makeJob({
        id: 'imp-002',
        mode: 'dry_run',
        status: 'validated',
        totalRows: 30,
        validRows: 24,
        invalidRows: 6,
        importedRows: 0,
        createdAt: '2026-10-05T15:50:00.000Z',
        finishedAt: '2026-10-05T15:50:01.000Z',
        version: 2,
      }),
      rows: rows.map((row) => (row.outcome === 'imported' ? { ...row, outcome: 'valid', entityId: null } : row)),
      events: [],
    },
    {
      job: makeJob({
        id: 'imp-003',
        mode: 'commit_all',
        status: 'failed',
        totalRows: 30,
        validRows: 24,
        invalidRows: 6,
        importedRows: 0,
        createdAt: '2026-10-04T18:10:00.000Z',
        finishedAt: '2026-10-04T18:10:01.000Z',
      }),
      rows: [
        ...invalid,
        ...imported.map((row) => ({ ...row, outcome: 'skipped' as const, entityId: null })),
      ].sort((a, b) => a.rowNumber - b.rowNumber),
      events: [],
    },
    {
      job: makeJob({
        id: 'imp-004',
        entity: 'employee',
        status: 'imported',
        totalRows: 12,
        validRows: 12,
        invalidRows: 0,
        importedRows: 12,
        createdAt: '2026-10-03T14:00:00.000Z',
        finishedAt: '2026-10-03T14:00:02.000Z',
      }),
      rows: Array.from({ length: 12 }, (_, index) =>
        makeRow({ rowNumber: index + 1, entityId: `emp-${String(900 + index)}` }),
      ),
      events: [],
    },
    {
      job: makeJob({
        id: 'imp-005',
        entity: 'employee',
        mode: 'dry_run',
        status: 'validated',
        totalRows: 12,
        validRows: 12,
        invalidRows: 0,
        importedRows: 0,
        createdAt: '2026-10-03T13:55:00.000Z',
        finishedAt: '2026-10-03T13:55:01.000Z',
      }),
      rows: Array.from({ length: 12 }, (_, index) =>
        makeRow({ rowNumber: index + 1, outcome: 'valid', entityId: null }),
      ),
      events: [],
    },
    {
      job: makeJob({
        id: 'imp-006',
        status: 'running',
        mode: 'commit_all',
        totalRows: 40,
        validRows: 40,
        invalidRows: 0,
        importedRows: 0,
        createdAt: '2026-10-02T09:00:00.000Z',
        finishedAt: null,
        version: 1,
      }),
      rows: [],
      events: [],
    },
  ];
  const filler: DemoImport[] = Array.from({ length: Math.max(0, count - curated.length) }, (_, index) => {
    const n = curated.length + index + 1;
    const day = String(Math.max(1, 28 - index)).padStart(2, '0');
    return {
      job: makeJob({
        id: `imp-${String(n).padStart(3, '0')}`,
        totalRows: 20,
        validRows: 20,
        invalidRows: 0,
        importedRows: 20,
        createdAt: `2026-09-${day}T10:00:00.000Z`,
        finishedAt: `2026-09-${day}T10:00:02.000Z`,
      }),
      rows: Array.from({ length: 20 }, (_, i) => makeRow({ rowNumber: i + 1, entityId: `veh-${String(100 + i)}` })),
      events: [],
    };
  });
  return [...curated, ...filler]
    .slice(0, count)
    .map((entry) => ({ ...entry, events: events(entry.job) }));
}
