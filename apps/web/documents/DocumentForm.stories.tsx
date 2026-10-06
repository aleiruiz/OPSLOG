import React from 'react';
import { PageHeader } from '@opslog/ui';
import type { VehicleOptions } from '../app/vehicleOptions';
import { DocumentForm, type DocumentFormProps } from './DocumentForm';
import { editValuesOf, emptyValues, renewalValuesOf, validate } from './formModel';
import { makeDocument } from './fixtures';
import { DocumentNotEditable, DocumentNotFound } from './DocumentMessages';
import { Frame, noop, storyNow } from './storyFrame';

export default {
  title: 'Flota/Documentos/Formulario',
  parameters: { layout: 'padded' },
};

const vehicles: VehicleOptions = {
  truncated: false,
  items: ['ECO-001', 'ECO-002', 'ECO-003'].map((economicNumber, index) => ({
    id: `veh-${String(index + 1).padStart(3, '0')}`,
    economicNumber,
    label: `${economicNumber} · Nissan NP300`,
  })),
};
const document = makeDocument({ notes: 'Original en la carpeta.', version: 3, revision: 2 });

const create = (props: Partial<DocumentFormProps> = {}) => (
  <Frame>
    <PageHeader
      title="Nuevo documento"
      description="Registra los datos del documento de un vehículo y cuándo vence. Los archivos llegarán más adelante."
    />
    <DocumentForm
      mode="create"
      vehicles={vehicles}
      cancelTo="/flota/documentos"
      onSubmit={noop}
      now={storyNow}
      {...props}
    />
  </Frame>
);
const change = (mode: 'edit' | 'renew', props: Partial<DocumentFormProps> = {}) => (
  <Frame>
    <PageHeader title={mode === 'edit' ? 'Editar documento' : 'Renovar documento'} />
    <DocumentForm
      mode={mode}
      initial={mode === 'edit' ? editValuesOf(document) : renewalValuesOf(document)}
      document={document}
      ownerName="ECO-001"
      cancelTo="/flota/documentos/doc-001"
      onSubmit={noop}
      now={storyNow}
      {...props}
    />
  </Frame>
);

export const Create = { render: () => create() };
export const CreateInvalid = {
  render: () => {
    const values = {
      ...emptyValues,
      title: '',
      typeCode: 'registration_card',
      expiresOn: '2020-01-01',
    };
    return create({ initial: values });
  },
};
export const CreateWithServerError = {
  render: () =>
    create({
      initial: {
        ...emptyValues,
        ownerId: 'veh-001',
        typeCode: 'registration_card',
        title: 'Tarjeta',
      },
      serverErrors: { ownerId: 'El vehículo no existe o está archivado. Elige otro de la lista.' },
      alert: {
        severity: 'error',
        title: 'El vehículo no es válido',
        message: 'Elige otro vehículo y vuelve a intentarlo.',
      },
    }),
};
export const CreateSaving = { render: () => create({ submitting: true }) };
export const CreateWithoutVehicles = {
  render: () => create({ vehicles: { items: [], truncated: false } }),
};
export const CreatePartialFleet = {
  render: () => create({ vehicles: { ...vehicles, truncated: true } }),
};
export const Edit = { render: () => change('edit') };
export const EditStale = {
  render: () =>
    change('edit', {
      alert: {
        severity: 'error',
        title: 'Otra persona modificó este documento',
        message: 'Carga los datos actuales para continuar; lo que escribiste se descartará.',
        actionLabel: 'Cargar datos actuales',
      },
      onAlertAction: noop,
    }),
};
export const Renew = { render: () => change('renew') };
export const RenewInvalid = {
  render: () => {
    const initial = {
      ...renewalValuesOf(document),
      issuedOn: '2027-01-01',
      expiresOn: '2026-01-01',
    };
    return change('renew', {
      initial,
      serverErrors: validate(initial, { mode: 'renew', now: storyNow }),
    });
  },
};
export const NotFound = {
  render: () => (
    <Frame>
      <DocumentNotFound />
    </Frame>
  ),
};
export const NotEditable = {
  render: () => (
    <Frame>
      <DocumentNotEditable documentId="doc-001" />
    </Frame>
  ),
};
