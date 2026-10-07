import React from 'react';
import type { ResourceState } from '../app/resource';
import type { VehicleOptions } from '../app/vehicleOptions';
import {
  AlertListView,
  noFilters,
  type AlertListData,
  type AlertListViewProps,
} from './AlertListView';
import { demoAlerts, makeAlert } from './fixtures';
import { Frame, noop } from './storyFrame';

// Plain CSF (no Storybook types): the web package does not depend on Storybook, the runtime lives in packages/ui.
export default {
  title: 'Flota/Alertas/Lista',
  parameters: { layout: 'padded' },
};

const vehicles: VehicleOptions = {
  truncated: false,
  items: ['ECO-001', 'ECO-002', 'ECO-003', 'ECO-004'].map((economicNumber, index) => ({
    id: `veh-${String(index + 1).padStart(3, '0')}`,
    economicNumber,
    label: `${economicNumber} · Nissan NP300`,
  })),
};

const page = (overrides: Partial<AlertListData> = {}): ResourceState<AlertListData> => ({
  status: 'ready',
  data: {
    items: demoAlerts(8),
    total: 34,
    nextCursor: 'cursor-demo',
    asOf: '2026-10-06',
    windowDays: 30,
    ...overrides,
  },
});

const view = (props: Partial<AlertListViewProps> = {}) => (
  <Frame>
    <AlertListView
      state={page()}
      filters={noFilters}
      vehicles={vehicles}
      filtersActive={false}
      onFiltersChange={noop}
      onClear={noop}
      onRetry={noop}
      onLoadMore={noop}
      {...props}
    />
  </Frame>
);

export const Default = { render: () => view() };
export const LastPage = { render: () => view({ state: page({ total: 8, nextCursor: null }) }) };
export const LoadingMore = { render: () => view({ loadingMore: true }) };
export const LoadMoreFailed = {
  render: () => view({ notice: { text: 'No pudimos cargar más alertas.', severity: 'error' } }),
};
export const VehiclesUnavailable = { render: () => view({ vehicles: null }) };
export const NarrowWindow = {
  render: () =>
    view({
      state: page({
        windowDays: 7,
        total: 2,
        nextCursor: null,
        items: [
          makeAlert({ subjectId: 'doc-a', dueOn: '2026-10-06', daysToExpiry: 0 }),
          makeAlert({
            source: 'insurance_policy',
            subjectId: 'pol-b',
            typeCode: 'third_party',
            dueOn: '2026-10-07',
            daysToExpiry: 1,
          }),
        ],
      }),
    }),
};
export const FilteredExpired = {
  render: () =>
    view({
      filters: { ...noFilters, severity: 'expired', source: 'insurance_policy' },
      filtersActive: true,
      state: page({
        total: 2,
        nextCursor: null,
        items: [
          makeAlert({
            source: 'insurance_policy',
            subjectId: 'pol-a',
            typeCode: 'comprehensive',
            dueOn: '2026-08-27',
            daysToExpiry: -40,
            severity: 'expired',
          }),
          makeAlert({
            source: 'insurance_policy',
            subjectId: 'pol-c',
            typeCode: 'mandatory_liability',
            dueOn: '2026-10-03',
            daysToExpiry: -3,
            severity: 'expired',
          }),
        ],
      }),
    }),
};
export const Loading = { render: () => view({ state: { status: 'loading' } }) };
export const Empty = {
  render: () => view({ state: page({ items: [], total: 0, nextCursor: null }) }),
};
export const NoResults = {
  render: () =>
    view({
      filters: { ...noFilters, severity: 'expired' },
      filtersActive: true,
      state: page({ items: [], total: 0, nextCursor: null }),
    }),
};
export const LoadFailed = {
  render: () =>
    view({
      state: {
        status: 'error',
        error: { code: 'internal_error', status: 500, message: 'x', correlationId: 'c' },
      },
    }),
};
export const Forbidden = { render: () => view({ state: { status: 'forbidden' } }) };
export const SessionExpired = { render: () => view({ state: { status: 'expired' } }) };
