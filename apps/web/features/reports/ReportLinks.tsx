import React from 'react';
import { RouterButton } from '../../app/router';
import { useSession } from '../../auth/session';

export interface ReportLink {
  readonly label: string;
  readonly reportId: string;
  /** Filters the report opens with (a record sheet names its record). */
  readonly filters?: Readonly<Record<string, string>>;
}

/** Address of a report with its filters; `ReportsScreen` applies the ones the report defines. */
export function reportPath(
  reportId: string,
  filters: Readonly<Record<string, string>> = {},
): string {
  const query = new URLSearchParams({ reporte: reportId });
  for (const [id, value] of Object.entries(filters)) if (value !== '') query.set(id, value);
  return `/analisis/reportes?${query.toString()}`;
}

/**
 * Links from a record to its PDF sheet and filtered reports. They follow the «Reportes» entry of the
 * navigation: without `export` nothing is rendered (the reports screen still checks the rest).
 */
export function ReportLinks({ links }: { readonly links: readonly ReportLink[] }) {
  const { can } = useSession();
  if (!can('export')) return null;
  return (
    <>
      {links.map((link) => (
        <RouterButton key={link.reportId} to={reportPath(link.reportId, link.filters)}>
          {link.label}
        </RouterButton>
      ))}
    </>
  );
}
