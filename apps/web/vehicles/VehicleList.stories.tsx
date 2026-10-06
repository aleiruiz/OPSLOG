import React from 'react';
import type { ResourceState } from '../app/resource';
import { demoVehicles, makeVehicle } from './fixtures';
import { Frame, noop } from './storyFrame';
import {
  noFilters,
  VehicleListView,
  type VehicleFilters,
  type VehicleListData,
  type VehicleListViewProps,
} from './VehicleListView';

// Plain CSF (no Storybook types): the web package does not depend on Storybook, the runtime lives in packages/ui.
export default {
  title: 'Flota/Vehiculos/Lista',
  parameters: { layout: 'padded' },
};

const page = (overrides: Partial<VehicleListData> = {}): ResourceState<VehicleListData> => ({
  status: 'ready',
  data: { items: demoVehicles(8), total: 28, nextCursor: 'cursor-demo', ...overrides },
});

const allowAll = () => true;
const readOnly = () => false;

const view = (props: Partial<VehicleListViewProps> = {}) => (
  <Frame>
    <VehicleListView
      state={page()}
      filters={noFilters}
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

const filtered: VehicleFilters = {
  status: 'in_maintenance',
  areaId: 'area-norte',
  includeArchived: true,
};

export const Default = { render: () => view() };
export const ReadOnly = { render: () => view({ can: readOnly }) };
export const LastPage = { render: () => view({ state: page({ total: 8, nextCursor: null }) }) };
export const LoadingMore = { render: () => view({ loadingMore: true }) };
export const LoadMoreFailed = {
  render: () => view({ notice: { text: 'No pudimos cargar más vehículos.', severity: 'error' } }),
};
export const FilteredWithArchived = {
  render: () =>
    view({
      filters: filtered,
      filtersActive: true,
      state: page({
        total: 2,
        nextCursor: null,
        items: [
          makeVehicle({ id: 'veh-a', economicNumber: 'ECO-014', status: 'in_maintenance' }),
          makeVehicle({
            id: 'veh-b',
            economicNumber: 'ECO-021',
            status: 'in_maintenance',
            archivedAt: '2026-09-30T10:00:00.000Z',
          }),
        ],
      }),
    }),
};
export const InvalidAreaFilter = {
  render: () =>
    view({
      filters: { ...noFilters, areaId: 'área norte' },
      areaError:
        'Usa letras, números, guion o guion bajo (hasta 64). El filtro no se aplica hasta que sea válido.',
    }),
};
export const NoResults = {
  render: () =>
    view({
      filters: { ...noFilters, status: 'out_of_service' },
      filtersActive: true,
      state: page({ items: [], total: 0, nextCursor: null }),
    }),
};
export const Empty = {
  render: () => view({ state: page({ items: [], total: 0, nextCursor: null }) }),
};
export const EmptyReadOnly = {
  render: () => view({ can: readOnly, state: page({ items: [], total: 0, nextCursor: null }) }),
};
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
