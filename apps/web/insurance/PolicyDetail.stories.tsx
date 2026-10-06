import React from 'react';
import type { ResourceState } from '../app/resource';
import type { InsurancePolicy, InsurancePolicyRevision } from '../app/types';
import { makePolicy } from './fixtures';
import {
  archiveClosed,
  PolicyDetailView,
  type HistoryPage,
  type PolicyDetailViewProps,
} from './PolicyDetailView';
import { Frame, noop } from './storyFrame';

export default {
  title: 'Flota/Seguros/Detalle',
  parameters: { layout: 'padded' },
};

const ready = (policy: InsurancePolicy): ResourceState<InsurancePolicy> => ({
  status: 'ready',
  data: policy,
});
const revision = (
  n: number,
  overrides: Partial<InsurancePolicyRevision> = {},
): InsurancePolicyRevision => ({
  revision: n,
  policyNumber: `POL-${2023 + n}-0001`,
  coverageType: 'comprehensive',
  startsOn: `${2023 + n}-03-01`,
  endsOn: `${2024 + n}-02-28`,
  status: 'replaced',
  hasDeductible: true,
  deductible: { kind: 'amount', amountMinor: 1_250_000, currency: 'MXN' },
  actorId: 'user-demo',
  at: `${2023 + n}-02-20T14:30:00.000Z`,
  ...overrides,
});
const historyOf = (
  items: InsurancePolicyRevision[],
  nextCursor: string | null = null,
): HistoryPage => ({
  items,
  nextCursor,
  total: items.length,
});
const base = makePolicy({
  coverageNotes: 'Incluye cristales y asistencia vial.',
  revision: 3,
  version: 5,
  hasDeductible: true,
  deductible: { kind: 'amount', amountMinor: 1_250_000, currency: 'MXN' },
  updatedAt: '2026-10-01T16:45:00.000Z',
});
const history = (props: Partial<PolicyDetailViewProps['history']> = {}) => ({
  state: {
    status: 'ready' as const,
    data: historyOf([revision(3, { status: 'valid' }), revision(2), revision(1)]),
  },
  onRetry: noop,
  onLoadMore: noop,
  ...props,
});

const view = (props: Partial<PolicyDetailViewProps> = {}) => (
  <Frame>
    <PolicyDetailView
      state={ready(base)}
      history={history()}
      vehicleName="ECO-001"
      can={() => true}
      archive={archiveClosed}
      onRetry={noop}
      onArchiveRequest={noop}
      onArchiveConfirm={noop}
      onArchiveCancel={noop}
      onArchiveErrorAction={noop}
      {...props}
    />
  </Frame>
);

const modal = { layout: 'padded', harness: 'modal' };

export const Default = { render: () => view() };
export const ReadOnly = { render: () => view({ can: () => false }) };
export const PercentDeductible = {
  render: () =>
    view({
      state: ready({ ...base, deductible: { kind: 'percent', basisPoints: 1250 } }),
    }),
};
/** A role without `view_costs`: the server masks the deductible, so only its existence is known. */
export const DeductibleMasked = {
  render: () => view({ state: ready({ ...base, deductible: null, hasDeductible: true }) }),
};
export const WithoutDeductible = {
  render: () => view({ state: ready({ ...base, deductible: null, hasDeductible: false }) }),
};
export const Expiring = {
  render: () =>
    view({ state: ready(makePolicy({ status: 'expiring', daysToExpiry: 12, revision: 1 })) }),
};
export const Expired = {
  render: () =>
    view({
      state: ready(
        makePolicy({ status: 'expired', daysToExpiry: -40, covering: false, revision: 1 }),
      ),
    }),
};
export const NotStarted = {
  render: () =>
    view({
      state: ready(
        makePolicy({ startsOn: '2026-11-01', endsOn: '2027-10-31', covering: false, revision: 1 }),
      ),
    }),
};
export const JustCreated = { render: () => view({ notice: 'Póliza creada.' }) };
export const JustRenewed = {
  render: () => view({ notice: 'Póliza renovada. La revisión anterior quedó en el historial.' }),
};
export const Archived = {
  render: () =>
    view({
      state: ready({ ...base, archivedAt: '2026-09-30T10:00:00.000Z', version: 6 }),
      notice: 'Póliza archivada.',
    }),
};
export const HistoryHasMore = {
  render: () =>
    view({
      history: history({
        state: {
          status: 'ready',
          data: {
            items: [revision(3, { status: 'valid' }), revision(2)],
            nextCursor: 'c',
            total: 3,
          },
        },
      }),
    }),
};
export const HistoryLoading = {
  render: () => view({ history: history({ state: { status: 'loading' } }) }),
};
export const HistoryFailed = {
  render: () =>
    view({
      history: history({
        state: {
          status: 'error',
          error: { code: 'internal_error', status: 500, message: 'x', correlationId: 'c' },
        },
      }),
    }),
};
export const Loading = { render: () => view({ state: { status: 'loading' } }) };
export const Forbidden = { render: () => view({ state: { status: 'forbidden' } }) };
export const ArchiveConfirmation = {
  parameters: modal,
  render: () => view({ archive: { open: true, busy: false } }),
};
export const ArchiveInProgress = {
  parameters: modal,
  render: () => view({ archive: { open: true, busy: true } }),
};
export const ArchiveStale = {
  parameters: modal,
  render: () =>
    view({
      archive: {
        open: true,
        busy: false,
        error: 'Otra persona modificó esta póliza. Carga los datos actuales y vuelve a intentarlo.',
        errorActionLabel: 'Cargar datos actuales',
      },
    }),
};
