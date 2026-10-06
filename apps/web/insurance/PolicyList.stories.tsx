import React from 'react';
import type { ResourceState } from '../app/resource';
import type { VehicleOptions } from '../app/vehicleOptions';
import { demoPolicies, makePolicy } from './fixtures';
import {
  noFilters,
  PolicyListView,
  type PolicyListData,
  type PolicyListViewProps,
} from './PolicyListView';
import { Frame, noop } from './storyFrame';

// Plain CSF (no Storybook types): the web package does not depend on Storybook, the runtime lives in packages/ui.
export default {
  title: 'Flota/Seguros/Lista',
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

const page = (overrides: Partial<PolicyListData> = {}): ResourceState<PolicyListData> => ({
  status: 'ready',
  data: { items: demoPolicies(8), total: 28, nextCursor: 'cursor-demo', ...overrides },
});

const view = (props: Partial<PolicyListViewProps> = {}) => (
  <Frame>
    <PolicyListView
      state={page()}
      filters={noFilters}
      vehicles={vehicles}
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

export const Default = { render: () => view() };
export const ReadOnly = { render: () => view({ can: () => false }) };
export const LastPage = { render: () => view({ state: page({ total: 8, nextCursor: null }) }) };
export const LoadingMore = { render: () => view({ loadingMore: true }) };
export const LoadMoreFailed = {
  render: () => view({ notice: { text: 'No pudimos cargar más pólizas.', severity: 'error' } }),
};
export const VehiclesUnavailable = { render: () => view({ vehicles: null }) };
export const InvalidDateFilter = {
  render: () =>
    view({
      filters: { ...noFilters, coversOn: '2026-13-45' },
      filtersActive: true,
      dateError: 'Escribe una fecha válida (AAAA-MM-DD).',
    }),
};
export const FilteredWithArchived = {
  render: () =>
    view({
      filters: { ...noFilters, status: 'expiring', includeArchived: true },
      filtersActive: true,
      state: page({
        total: 2,
        nextCursor: null,
        items: [
          makePolicy({ id: 'pol-a', status: 'expiring', daysToExpiry: 12 }),
          makePolicy({
            id: 'pol-b',
            policyNumber: 'POL-2026-0002',
            status: 'expiring',
            daysToExpiry: 3,
            archivedAt: '2026-09-30T10:00:00.000Z',
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
      filters: { ...noFilters, status: 'expired' },
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
