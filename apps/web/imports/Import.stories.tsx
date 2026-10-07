import React from 'react';
import { PageHeader } from '@opslog/ui';
import type { ResourceState } from '../app/resource';
import type { ImportJob } from '../app/types';
import { demoImports, demoRows, makeEvent, makeJob, makeRow } from './fixtures';
import {
  ImportDetailView,
  type HistoryPage,
  type ImportDetailViewProps,
  type RowsPage,
} from './ImportDetailView';
import { ImportForm, type ImportFormProps } from './ImportForm';
import { ImportListView, noFilters, type ImportListData } from './ImportListView';
import { ImportNotFound } from './ImportMessages';
import { Frame, noop } from './storyFrame';

// Plain CSF (no Storybook types): the web package does not depend on Storybook, the runtime lives in packages/ui.
export default {
  title: 'Flota/Importaciones',
  parameters: { layout: 'padded' },
};

const jobs = demoImports(8).map((entry) => entry.job);
const page = (overrides: Partial<ImportListData> = {}): ResourceState<ImportListData> => ({
  status: 'ready',
  data: { items: jobs, total: 28, nextCursor: 'cursor-demo', ...overrides },
});
const list = (props: Partial<React.ComponentProps<typeof ImportListView>> = {}) => (
  <Frame>
    <ImportListView
      state={page()}
      filters={noFilters}
      can={() => true}
      filtersActive={false}
      onFiltersChange={noop}
      onClear={noop}
      onRetry={noop}
      onLoadMore={noop}
      {...props}
    />
  </Frame>
);

export const ListDefault = { render: () => list() };
export const ListReadOnly = { render: () => list({ can: () => false }) };
export const ListLastPage = { render: () => list({ state: page({ total: 8, nextCursor: null }) }) };
export const ListLoadingMore = { render: () => list({ loadingMore: true }) };
export const ListLoadMoreFailed = {
  render: () =>
    list({ notice: { text: 'No pudimos cargar más importaciones.', severity: 'error' } }),
};
export const ListFiltered = {
  render: () =>
    list({
      filters: { entity: 'employee', status: 'imported' },
      filtersActive: true,
      state: page({
        total: 1,
        nextCursor: null,
        items: jobs.filter((job) => job.entity === 'employee' && job.status === 'imported'),
      }),
    }),
};
export const ListLoading = { render: () => list({ state: { status: 'loading' } }) };
export const ListEmpty = {
  render: () => list({ state: page({ items: [], total: 0, nextCursor: null }) }),
};
export const ListEmptyReadOnly = {
  render: () => list({ can: () => false, state: page({ items: [], total: 0, nextCursor: null }) }),
};
export const ListNoResults = {
  render: () =>
    list({ filtersActive: true, state: page({ items: [], total: 0, nextCursor: null }) }),
};
export const ListError = {
  render: () =>
    list({
      state: { status: 'error', error: { code: 'internal', status: 500, message: 'x' } as never },
    }),
};

const ready = <T,>(data: T): ResourceState<T> => ({ status: 'ready', data });
const rowsPage = (
  items = demoRows(30).slice(0, 25),
  nextCursor: string | null = 'mock:25',
): RowsPage => ({
  items,
  total: 30,
  nextCursor,
});
const historyOf = (job: ImportJob): HistoryPage => ({
  items: [
    ...(job.finishedAt === null
      ? []
      : [
          makeEvent({
            seq: 2,
            kind:
              job.status === 'failed'
                ? 'failed'
                : job.status === 'validated'
                  ? 'validated'
                  : 'imported',
            acceptedRows: job.validRows,
            rejectedRows: job.invalidRows,
            at: job.finishedAt,
          }),
        ]),
    makeEvent({ at: job.createdAt }),
  ],
  total: 2,
  nextCursor: null,
});
const detail = (job: ImportJob, props: Partial<ImportDetailViewProps> = {}) => (
  <Frame>
    <ImportDetailView
      state={ready(job)}
      rows={{
        state: ready(rowsPage()),
        outcome: '',
        onOutcomeChange: noop,
        onRetry: noop,
        onLoadMore: noop,
      }}
      history={{ state: ready(historyOf(job)), onRetry: noop, onLoadMore: noop }}
      onRetry={noop}
      {...props}
    />
  </Frame>
);

export const DetailImported = { render: () => detail(makeJob()) };
export const DetailImportedNotice = {
  render: () => detail(makeJob(), { notice: 'Importación terminada. Revisa el informe por fila.' }),
};
export const DetailReplayed = {
  render: () =>
    detail(makeJob(), {
      notice:
        'Esta solicitud ya se había procesado: mostramos el resultado guardado y no se creó nada nuevo.',
    }),
};
export const DetailValidated = {
  render: () =>
    detail(
      makeJob({
        mode: 'dry_run',
        status: 'validated',
        importedRows: 0,
        validRows: 24,
        invalidRows: 6,
        totalRows: 30,
      }),
    ),
};
export const DetailFailedAllOrNothing = {
  render: () =>
    detail(
      makeJob({
        mode: 'commit_all',
        status: 'failed',
        importedRows: 0,
        validRows: 24,
        invalidRows: 6,
        totalRows: 30,
      }),
    ),
};
export const DetailRunning = {
  render: () => detail(makeJob({ status: 'running', finishedAt: null, importedRows: 0 })),
};
export const DetailEmployees = {
  render: () =>
    detail(
      makeJob({
        entity: 'employee',
        totalRows: 12,
        validRows: 12,
        invalidRows: 0,
        importedRows: 12,
      }),
    ),
};
export const DetailNoRowsWithOutcome = {
  render: () =>
    detail(makeJob(), {
      rows: {
        state: ready({ items: [], total: 0, nextCursor: null }),
        outcome: 'skipped',
        onOutcomeChange: noop,
        onRetry: noop,
        onLoadMore: noop,
      },
    }),
};
export const DetailRowsFailed = {
  render: () =>
    detail(makeJob(), {
      rows: {
        state: { status: 'error', error: { code: 'internal', status: 500, message: 'x' } as never },
        outcome: '',
        onOutcomeChange: noop,
        onRetry: noop,
        onLoadMore: noop,
      },
    }),
};
export const DetailMoreRowsFailed = {
  render: () =>
    detail(makeJob(), {
      rows: {
        state: ready(rowsPage()),
        notice: 'No pudimos cargar más filas.',
        outcome: '',
        onOutcomeChange: noop,
        onRetry: noop,
        onLoadMore: noop,
      },
    }),
};
export const DetailLoading = { render: () => detail(makeJob(), { state: { status: 'loading' } }) };
export const DetailNotFound = {
  render: () =>
    detail(makeJob(), {
      state: { status: 'error', error: { code: 'not_found', status: 404, message: 'x' } as never },
    }),
};
export const NotFound = {
  render: () => (
    <Frame>
      <ImportNotFound />
    </Frame>
  ),
};

const vehicleCsv = [
  'economicNumber,plate,make,model,year,areaId,odometerKm',
  'ECO-101,NEW-101,Nissan,NP300,2022,area-norte,1200',
  'ECO-102,NEW-102,Toyota,Hilux,2023,area-norte,800',
  'ECO-103,,Nissan,NP300,2022,area-norte,100',
].join('\n');
const employeeCsv = [
  'kind,firstName,lastName,areaId,email',
  'driver,Ana,García,area-norte,ana@ejemplo.test',
].join('\n');
const create = (props: Partial<ImportFormProps> = {}) => (
  <Frame>
    <PageHeader
      title="Nueva importación"
      description="Importa vehículos o empleados desde un archivo CSV. Valida primero: la validación no crea nada y te dice qué filas tienen errores."
    />
    <ImportForm
      canViewPii={false}
      cancelTo="/flota/importaciones"
      onSubmit={noop}
      onConfirm={noop}
      {...props}
    />
  </Frame>
);
const validation = (
  job: Partial<ImportJob> = {},
  rows: ResourceState<{ items: ReturnType<typeof demoRows>; total: number }> = ready({
    items: [
      makeRow({
        rowNumber: 3,
        outcome: 'invalid',
        code: 'missing_value',
        columns: ['plate'],
        entityId: null,
      }),
    ],
    total: 1,
  }),
) => ({
  job: makeJob({
    mode: 'dry_run',
    status: 'validated',
    totalRows: 3,
    validRows: 2,
    invalidRows: 1,
    importedRows: 0,
    ...job,
  }),
  fileSignature: JSON.stringify(['vehicle', vehicleCsv]),
  rows,
});

export const FormEmpty = { render: () => create() };
export const FormPasted = { render: () => create({ initial: { csv: vehicleCsv } }) };
export const FormCommitMode = {
  render: () => create({ initial: { csv: vehicleCsv, mode: 'commit_valid' } }),
};
export const FormEmployeesWithoutPii = {
  render: () => create({ initial: { entity: 'employee', csv: employeeCsv } }),
};
export const FormEmployeesWithPii = {
  render: () => create({ canViewPii: true, initial: { entity: 'employee', csv: employeeCsv } }),
};
export const FormSubmitting = {
  render: () =>
    create({ initial: { csv: vehicleCsv }, submitting: true, submittingMode: 'dry_run' }),
};
export const FormValidatedWithErrors = {
  render: () => create({ initial: { csv: vehicleCsv }, validation: validation() }),
};
export const FormValidatedAllValid = {
  render: () =>
    create({
      initial: { csv: vehicleCsv },
      validation: validation({ validRows: 3, invalidRows: 0 }, ready({ items: [], total: 0 })),
    }),
};
export const FormValidatedLoadingReport = {
  render: () =>
    create({ initial: { csv: vehicleCsv }, validation: validation({}, { status: 'loading' }) }),
};
export const FormValidatedReportFailed = {
  render: () =>
    create({
      initial: { csv: vehicleCsv },
      validation: validation(
        {},
        { status: 'error', error: { code: 'internal', status: 500, message: 'x' } as never },
      ),
    }),
};
export const FormValidationStale = {
  render: () =>
    create({
      initial: { csv: `${vehicleCsv}\nECO-104,NEW-104,Nissan,NP300,2022,area-norte,5` },
      validation: validation(),
    }),
};
export const FormConfirming = {
  render: () =>
    create({
      initial: { csv: vehicleCsv },
      validation: validation(),
      submitting: true,
      submittingMode: 'commit_valid',
    }),
};
export const FormConflict = {
  render: () =>
    create({
      initial: { csv: vehicleCsv, mode: 'commit_all' },
      alert: {
        severity: 'error',
        title: 'No pudimos importar con esta solicitud',
        message:
          'La solicitud choca con otra anterior: el archivo cambió respecto a la validación, se usó la misma clave con otro contenido, o hay una importación en curso. No se creó nada nuevo. Revisa el historial antes de reintentar.',
        actionLabel: 'Ver el historial de importaciones',
      },
      onAlertAction: noop,
    }),
};
export const FormServerError = {
  render: () =>
    create({
      initial: { csv: vehicleCsv },
      alert: {
        severity: 'error',
        title: 'No pudimos validar el archivo',
        message: 'Intenta nuevamente.',
      },
    }),
};
