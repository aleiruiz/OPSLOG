import React from 'react';
import type { BffReportSummary } from '@opslog/contracts';
import { Button, FilterBar, Field, InlineAlert, PageHeader, Panel } from '@opslog/ui';
import { NoSubmit, ResourceView, useResource } from '../../app/resource';
import { useSession } from '../../auth/session';
import { ColumnSelector } from './ColumnSelector';
import { ExportPanel } from './ExportPanel';
import { FilterFields } from './FilterFields';
import { copy } from './labels';
import { PreviewTable } from './PreviewTable';

export const PREVIEW_PAGE = 25;

/** The page of rows for the query on screen; it loads again whenever the query changes. */
function PreviewBody({
  reportId,
  title,
  query,
  onPage,
}: {
  readonly reportId: string;
  readonly title: string;
  readonly query: Readonly<Record<string, string | number>>;
  readonly onPage: (offset: number) => void;
}) {
  const { ports } = useSession();
  const { state, reload } = useResource(
    () => ports.reports.preview(reportId, query),
    [ports, reportId, JSON.stringify(query)],
  );
  return (
    <ResourceView state={state} onRetry={reload}>
      {(preview) => <PreviewTable preview={preview} title={title} onPage={onPage} />}
    </ResourceView>
  );
}

/** One report: filters, column selector, paginated preview and the export. */
export function ReportWorkspace({
  report,
  canExport,
  onBack,
  onShowExports,
}: {
  readonly report: BffReportSummary;
  readonly canExport: boolean;
  readonly onBack: () => void;
  readonly onShowExports: () => void;
}) {
  const uid = React.useId();
  const defaults = report.columns.filter((c) => c.defaultVisible).map((c) => c.id);
  const [columns, setColumns] = React.useState<readonly string[]>(
    defaults.length > 0 ? defaults : report.columns.slice(0, 1).map((c) => c.id),
  );
  const [draft, setDraft] = React.useState<Readonly<Record<string, string>>>({});
  const [applied, setApplied] = React.useState<Readonly<Record<string, string>>>({});
  const [sort, setSort] = React.useState(report.defaultSort.column);
  const [direction, setDirection] = React.useState<'asc' | 'desc'>(report.defaultSort.direction);
  const [offset, setOffset] = React.useState(0);

  const filters = Object.fromEntries(Object.entries(applied).filter(([, value]) => value !== ''));
  const request = { columns: [...columns], filters, sort, direction } as const;
  // A required filter without a value: nothing is loaded and nothing can be exported yet.
  const missing = report.filters.some((f) => f.required === true && filters[f.id] === undefined);
  const query = {
    columns: columns.join(','),
    sort,
    direction,
    limit: PREVIEW_PAGE,
    offset,
    ...filters,
  };
  const restart = (change: () => void) => {
    change();
    setOffset(0);
  };

  return (
    <>
      <PageHeader eyebrow="Reportes" title={report.title} description={report.description} />
      <Button variant="text" onClick={onBack}>
        {copy.back}
      </Button>
      <NoSubmit>
        {report.filters.length > 0 && (
          <Panel title={copy.filters}>
            <FilterBar
              onClear={() =>
                restart(() => {
                  setDraft({});
                  setApplied({});
                })
              }
            >
              <FilterFields
                filters={report.filters}
                values={draft}
                onChange={(id, value) => setDraft({ ...draft, [id]: value })}
              />
              <Button variant="outlined" onClick={() => restart(() => setApplied(draft))}>
                Aplicar filtros
              </Button>
            </FilterBar>
          </Panel>
        )}
        <Panel>
          <ColumnSelector
            columns={report.columns}
            selected={columns}
            onChange={(next) => restart(() => setColumns(next))}
          />
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 16 }}>
            <Field
              id={`${uid}-sort`}
              label={copy.sort}
              select
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true }}
              value={sort}
              onChange={(event) => restart(() => setSort(event.target.value))}
            >
              {report.columns.map((column) => (
                <option key={column.id} value={column.id}>
                  {column.label}
                </option>
              ))}
            </Field>
            <Field
              id={`${uid}-direction`}
              label={copy.direction}
              select
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true }}
              value={direction}
              onChange={(event) =>
                restart(() => setDirection(event.target.value === 'desc' ? 'desc' : 'asc'))
              }
            >
              <option value="asc">{copy.asc}</option>
              <option value="desc">{copy.desc}</option>
            </Field>
          </div>
        </Panel>
      </NoSubmit>
      <Panel title={copy.preview} flush>
        {missing ? (
          <InlineAlert severity="info">{copy.needFilters}</InlineAlert>
        ) : (
          <PreviewBody reportId={report.id} title={report.title} query={query} onPage={setOffset} />
        )}
      </Panel>
      <ExportPanel
        report={report}
        canExport={canExport}
        blocked={missing}
        request={request}
        onShowExports={onShowExports}
      />
    </>
  );
}
