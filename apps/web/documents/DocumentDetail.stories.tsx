import React from 'react';
import type { ResourceState } from '../app/resource';
import type { Document, DocumentRevision } from '../app/types';
import {
  archiveClosed,
  DocumentDetailView,
  type DocumentDetailViewProps,
  type HistoryPage,
} from './DocumentDetailView';
import { makeDocument } from './fixtures';
import { Frame, noop } from './storyFrame';

export default {
  title: 'Flota/Documentos/Detalle',
  parameters: { layout: 'padded' },
};

const ready = (document: Document): ResourceState<Document> => ({
  status: 'ready',
  data: document,
});
const revision = (n: number, overrides: Partial<DocumentRevision> = {}): DocumentRevision => ({
  revision: n,
  issuedOn: `${2022 + n}-11-20`,
  expiresOn: `${2023 + n}-11-20`,
  documentNumber: `TC-${2022 + n}-0001`,
  status: 'replaced',
  actorId: 'user-demo',
  at: `${2022 + n}-11-20T14:30:00.000Z`,
  ...overrides,
});
const historyOf = (items: DocumentRevision[], nextCursor: string | null = null): HistoryPage => ({
  items,
  nextCursor,
  total: items.length,
});
const base = makeDocument({
  notes: 'Original en la carpeta de la unidad.',
  revision: 3,
  version: 5,
  updatedAt: '2026-10-01T16:45:00.000Z',
});
const history = (props: Partial<DocumentDetailViewProps['history']> = {}) => ({
  state: {
    status: 'ready' as const,
    data: historyOf([revision(3, { status: 'valid' }), revision(2), revision(1)]),
  },
  onRetry: noop,
  onLoadMore: noop,
  ...props,
});

const view = (props: Partial<DocumentDetailViewProps> = {}) => (
  <Frame>
    <DocumentDetailView
      state={ready(base)}
      history={history()}
      ownerName="ECO-001"
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
export const Expiring = {
  render: () =>
    view({ state: ready(makeDocument({ status: 'expiring', daysToExpiry: 12, revision: 1 })) }),
};
export const Expired = {
  render: () =>
    view({ state: ready(makeDocument({ status: 'expired', daysToExpiry: -40, revision: 1 })) }),
};
export const EmployeeOwner = {
  render: () =>
    view({
      state: ready(makeDocument({ ownerType: 'employee', ownerId: 'emp-001' })),
      ownerName: null,
    }),
};
export const JustCreated = { render: () => view({ notice: 'Documento creado.' }) };
export const JustRenewed = {
  render: () => view({ notice: 'Documento renovado. La revisión anterior quedó en el historial.' }),
};
export const Archived = {
  render: () =>
    view({
      state: ready(makeDocument({ archivedAt: '2026-09-30T10:00:00.000Z', version: 6 })),
      notice: 'Documento archivado.',
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
        error:
          'Otra persona modificó este documento. Carga los datos actuales y vuelve a intentarlo.',
        errorActionLabel: 'Cargar datos actuales',
      },
    }),
};
