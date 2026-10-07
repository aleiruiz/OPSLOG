import React from 'react';
import type { ApiError } from '../app/types';
import type { DriverOptions } from '../app/driverOptions';
import type { ResourceState } from '../app/resource';
import type { VehicleOptions } from '../app/vehicleOptions';
import { AssignmentForm, type AssignmentFormProps } from './AssignmentForm';
import { describeFailure } from './AssignmentFormScreen';
import { AssignmentListView, noFilters, type AssignmentListData } from './AssignmentListView';
import { AssignmentNotEndable, AssignmentNotFound } from './AssignmentMessages';
import { closed, demoAssignments, makeAssignment, makeEvent } from './fixtures';
import { emptyAssign } from './formModel';
import {
  AssignmentDetailView,
  type AssignmentDetailViewProps,
  type HistoryPage,
} from './AssignmentDetailView';
import { PageHeader } from '@opslog/ui';
import { Frame, noop } from './storyFrame';

// Plain CSF (no Storybook types): the web package does not depend on Storybook, the runtime lives in packages/ui.
export default {
  title: 'Flota/Asignaciones',
  parameters: { layout: 'padded' },
};

const vehicles: VehicleOptions = {
  truncated: false,
  items: ['ECO-001', 'ECO-002', 'ECO-003', 'ECO-004'].map((economicNumber, index) => ({
    id: `veh-${String(index + 1).padStart(3, '0')}`,
    economicNumber,
    label: `${economicNumber} · Nissan NP300`,
    status: 'active',
  })),
};
const drivers: DriverOptions = {
  truncated: false,
  items: ['Ana García López', 'Luis Pérez Soto', 'María Ruiz Vega'].map((name, index) => ({
    id: `emp-${String(index + 1).padStart(3, '0')}`,
    label: `${name} · E-${100 + index}`,
    name,
    status: 'active',
  })),
};

const page = (overrides: Partial<AssignmentListData> = {}): ResourceState<AssignmentListData> => ({
  status: 'ready',
  data: { items: demoAssignments(8), total: 28, nextCursor: 'cursor-demo', ...overrides },
});
const list = (props: Partial<React.ComponentProps<typeof AssignmentListView>> = {}) => (
  <Frame>
    <AssignmentListView
      state={page()}
      filters={noFilters}
      vehicles={vehicles}
      drivers={drivers}
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
    list({ notice: { text: 'No pudimos cargar más asignaciones.', severity: 'error' } }),
};
export const ListNamesUnavailable = { render: () => list({ vehicles: null, drivers: null }) };
export const ListHistoryOfOneVehicle = {
  render: () =>
    list({
      filters: { ...noFilters, vehicleId: 'veh-001', status: 'ended' },
      filtersActive: true,
      state: page({ total: 2, nextCursor: null, items: demoAssignments(8).slice(0, 2) }),
    }),
};
export const ListLoading = { render: () => list({ state: { status: 'loading' } }) };
export const ListEmpty = {
  render: () => list({ state: page({ items: [], total: 0, nextCursor: null }) }),
};
export const ListNoResults = {
  render: () =>
    list({
      filtersActive: true,
      state: page({ items: [], total: 0, nextCursor: null }),
    }),
};
export const ListError = {
  render: () =>
    list({
      state: { status: 'error', error: { code: 'internal', status: 500, message: 'x' } as never },
    }),
};

const ready = (value: ReturnType<typeof makeAssignment>) =>
  ({ status: 'ready', data: value }) as ResourceState<ReturnType<typeof makeAssignment>>;
const events = (items: HistoryPage['items'], nextCursor: string | null = null): HistoryPage => ({
  items,
  nextCursor,
  total: items.length,
});
const detail = (props: Partial<AssignmentDetailViewProps> = {}) => (
  <Frame>
    <AssignmentDetailView
      state={ready(makeAssignment())}
      history={{
        state: {
          status: 'ready',
          data: events([makeEvent()]),
        },
        onRetry: noop,
        onLoadMore: noop,
      }}
      vehicleName="ECO-001"
      driverName="Ana García López"
      can={() => true}
      onRetry={noop}
      {...props}
    />
  </Frame>
);

export const DetailCurrent = { render: () => detail() };
export const DetailCurrentReadOnly = { render: () => detail({ can: () => false }) };
export const DetailEnded = {
  render: () =>
    detail({
      state: ready(closed(makeAssignment())),
      history: {
        state: {
          status: 'ready',
          data: events([
            makeEvent({
              seq: 2,
              kind: 'ended',
              reason: 'Fin de la ruta',
              at: '2026-06-15T18:30:00.000Z',
            }),
            makeEvent(),
          ]),
        },
        onRetry: noop,
        onLoadMore: noop,
      },
    }),
};
export const DetailReplaced = {
  render: () =>
    detail({
      state: ready(closed(makeAssignment(), 'replaced')),
      history: {
        state: {
          status: 'ready',
          data: events(
            [
              makeEvent({
                seq: 2,
                kind: 'replaced',
                reason: 'Cambio de conductor titular',
                at: '2026-06-15T18:30:00.000Z',
              }),
              makeEvent(),
            ],
            'cursor-demo',
          ),
        },
        onRetry: noop,
        onLoadMore: noop,
      },
    }),
};
export const DetailSecondary = {
  render: () =>
    detail({
      state: ready(makeAssignment({ type: 'secondary', reason: 'Apoyo en rutas largas' })),
    }),
};
export const DetailCreated = {
  render: () =>
    detail({ notice: 'Asignación creada. El conductor ya aparece como principal del vehículo.' }),
};
export const DetailHistoryFailed = {
  render: () =>
    detail({
      history: {
        state: { status: 'error', error: { code: 'internal', status: 500, message: 'x' } as never },
        onRetry: noop,
        onLoadMore: noop,
      },
    }),
};
export const DetailLoading = { render: () => detail({ state: { status: 'loading' } }) };
export const DetailNotFound = {
  render: () =>
    detail({
      state: { status: 'error', error: { code: 'not_found', status: 404, message: 'x' } as never },
    }),
};

const formProps: AssignmentFormProps = {
  mode: 'assign',
  vehicles,
  drivers,
  canReplace: true,
  cancelTo: '/flota/asignaciones',
  onSubmit: noop,
};
const create = (props: Partial<AssignmentFormProps> = {}) => (
  <Frame>
    <PageHeader
      title="Nueva asignación"
      description="Asigna un conductor a un vehículo como principal, secundario o temporal."
    />
    <AssignmentForm {...formProps} {...props} />
  </Frame>
);
const failure = (
  code: string,
  status: number,
  fields: string[] = [],
  canReplace = true,
): Partial<AssignmentFormProps> => {
  const error = {
    code,
    status,
    message: 'x',
    correlationId: 'corr-demo',
    fieldErrors: fields.map((field) => ({ field, code })),
  } as unknown as ApiError;
  const { alert, fields: serverErrors } = describeFailure(error, 'assign', canReplace);
  return { alert, serverErrors, canReplace };
};

export const FormEmpty = { render: () => create() };
export const FormPrefilled = {
  render: () =>
    create({
      initial: {
        ...emptyAssign,
        vehicleId: 'veh-002',
        employeeId: 'emp-002',
        type: 'secondary',
        reason: 'Apoyo en rutas largas',
      },
    }),
};
export const FormWithoutReplace = { render: () => create({ canReplace: false }) };
export const FormSubmitting = { render: () => create({ submitting: true }) };
export const FormPickersUnavailable = {
  render: () =>
    create({ vehicles: { items: [], truncated: false }, drivers: { items: [], truncated: true } }),
};
export const FormConflictBr002 = {
  render: () => create(failure('principal_taken', 409, ['vehicle_id'])),
};
export const FormConflictBr002WithoutReplace = {
  render: () => create(failure('principal_taken', 409, ['vehicle_id'], false)),
};
export const FormConflictBr003 = {
  render: () => create(failure('principal_taken', 409, ['employee_id'])),
};
export const FormConflictAlreadyAssigned = {
  render: () => create(failure('already_assigned', 409, ['employee_id'])),
};
export const FormConflictBr014 = {
  render: () => create(failure('invalid_vehicle', 422, ['vehicle_id'])),
};

const toEnd = (props: Partial<AssignmentFormProps> = {}) => (
  <Frame>
    <PageHeader title="Cerrar asignación" />
    <AssignmentForm
      mode="end"
      assignment={makeAssignment()}
      vehicleName="ECO-001"
      driverName="Ana García López"
      cancelTo="/flota/asignaciones/asg-001"
      onSubmit={noop}
      {...props}
    />
  </Frame>
);
export const EndForm = { render: () => toEnd() };
export const EndStale = {
  render: () => {
    const { alert } = describeFailure(
      { code: 'stale_version', status: 409, message: 'x', correlationId: 'c' } as never,
      'end',
    );
    return toEnd({ alert });
  },
};
export const EndAlreadyClosed = {
  render: () => (
    <Frame>
      <AssignmentNotEndable assignmentId="asg-005" />
    </Frame>
  ),
};
export const NotFound = {
  render: () => (
    <Frame>
      <AssignmentNotFound />
    </Frame>
  ),
};
