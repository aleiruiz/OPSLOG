import React from 'react';
import { DetailTabs, PageHeader, UiState } from '@opslog/ui';
import { ResourceView, useResource } from '../../app/resource';
import { useRouter } from '../../app/router';
import { useSession } from '../../auth/session';
import { CatalogTab } from './CatalogTab';
import { ExportsTab } from './ExportsTab';
import { copy } from './labels';
import { ReportWorkspace } from './ReportWorkspace';

/** Filters named in the address (`?reporte=x&vehicle=ECO-1`): only the ones the report defines. */
function initialFilters(
  ids: readonly string[],
  search: URLSearchParams,
): Readonly<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const id of ids) {
    const value = search.get(id);
    if (value) found[id] = value;
  }
  return found;
}

/**
 * `/analisis/reportes`: the catalog by family, a report with its preview and export, and the
 * person's exports. The open report and the tab live in the address, so a reload keeps them.
 */
export function ReportsScreen({ pollMs }: { readonly pollMs?: number | undefined }) {
  const { can, ports } = useSession();
  const router = useRouter();
  const { state, reload } = useResource(() => ports.reports.catalog(), [ports]);
  if (!can('view')) return <UiState kind="no-permission" />;

  const reportId = router.search.get('reporte');
  const tab = router.search.get('pestana') === 'exportaciones' ? 'exports' : 'catalog';
  const go = (query: Record<string, string>) => {
    const search = new URLSearchParams(query).toString();
    router.navigate(`/analisis/reportes${search ? `?${search}` : ''}`);
  };

  return (
    <ResourceView state={state} onRetry={reload}>
      {(catalog) => {
        const report = catalog.reports.find((item) => item.id === reportId);
        if (report && tab === 'catalog')
          return (
            <ReportWorkspace
              key={report.id}
              report={report}
              initialFilters={initialFilters(
                report.filters.map((f) => f.id),
                router.search,
              )}
              canExport={catalog.canExport}
              onBack={() => go({})}
              onShowExports={() => go({ pestana: 'exportaciones' })}
            />
          );
        return (
          <>
            <PageHeader eyebrow="Análisis" title={copy.title} description={copy.description} />
            <DetailTabs
              value={tab}
              onChange={(next) => go(next === 'exports' ? { pestana: 'exportaciones' } : {})}
              tabs={[
                {
                  id: 'catalog',
                  label: copy.catalogTab,
                  content: <CatalogTab catalog={catalog} onOpen={(id) => go({ reporte: id })} />,
                },
                { id: 'exports', label: copy.exportsTab, content: <ExportsTab pollMs={pollMs} /> },
              ]}
            />
          </>
        );
      }}
    </ResourceView>
  );
}
