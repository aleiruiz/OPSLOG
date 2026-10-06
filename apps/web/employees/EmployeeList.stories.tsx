import React from 'react';
import type { ResourceState } from '../app/resource';
import { demoAreas } from '../areas/fixtures';
import { demoEmployees, makeEmployee } from './fixtures';
import { Frame, noop } from './storyFrame';
import {
  EmployeeListView,
  noFilters,
  type EmployeeFilters,
  type EmployeeListData,
  type EmployeeListViewProps,
} from './EmployeeListView';

// Plain CSF (no Storybook types): the web package does not depend on Storybook, the runtime lives in packages/ui.
export default {
  title: 'Plantilla/Empleados/Lista',
  parameters: { layout: 'padded' },
};

const areas = demoAreas();
const page = (overrides: Partial<EmployeeListData> = {}): ResourceState<EmployeeListData> => ({
  status: 'ready',
  data: { items: demoEmployees().slice(0, 8), total: 28, nextCursor: 'cursor-demo', ...overrides },
});

const allowAll = () => true;
const readOnly = () => false;
const none = { items: [], total: 0, nextCursor: null };

const view = (props: Partial<EmployeeListViewProps> = {}) => (
  <Frame>
    <EmployeeListView
      state={page()}
      filters={noFilters}
      areas={areas}
      can={allowAll}
      filtersActive={false}
      onFiltersChange={noop}
      onClear={noop}
      onRetry={noop}
      onLoadMore={noop}
      {...props}
    />
  </Frame>
);

const filtered: EmployeeFilters = {
  kind: 'driver',
  status: 'active',
  areaId: 'area-norte',
  includeArchived: true,
};

export const Default = { render: () => view() };
export const ReadOnly = { render: () => view({ can: readOnly }) };
export const LastPage = { render: () => view({ state: page({ total: 8, nextCursor: null }) }) };
export const LoadingMore = { render: () => view({ loadingMore: true }) };
export const LoadMoreFailed = {
  render: () => view({ notice: { text: 'No pudimos cargar más empleados.', severity: 'error' } }),
};
export const FilteredWithArchived = {
  render: () =>
    view({
      filters: filtered,
      filtersActive: true,
      state: page({
        total: 3,
        nextCursor: null,
        items: [
          makeEmployee({ id: 'emp-a', firstName: 'Ana', lastName: 'García López' }),
          makeEmployee({
            id: 'emp-b',
            firstName: 'Luis',
            lastName: 'Hernández Ruiz',
            licenseExpiresOn: '2026-08-31',
          }),
          makeEmployee({
            id: 'emp-c',
            firstName: 'Sofía',
            lastName: 'Torres Vega',
            archivedAt: '2026-09-30T10:00:00.000Z',
          }),
        ],
      }),
    }),
};
export const NoResults = {
  render: () =>
    view({
      filters: { ...noFilters, kind: 'dispatcher', status: 'terminated' },
      filtersActive: true,
      state: page(none),
    }),
};
export const Empty = { render: () => view({ state: page(none) }) };
export const EmptyReadOnly = { render: () => view({ can: readOnly, state: page(none) }) };
export const Loading = { render: () => view({ state: { status: 'loading' } }) };
export const Error = {
  render: () =>
    view({
      state: {
        status: 'error',
        error: { code: 'internal_error', status: 500, message: 'x', correlationId: 'c' },
      },
    }),
};
export const NoPermission = {
  render: () => view({ state: { status: 'forbidden' }, can: readOnly }),
};
export const SessionExpired = { render: () => view({ state: { status: 'expired' } }) };
