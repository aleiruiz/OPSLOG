import React from 'react';
import { PageHeader } from '@opslog/ui';
import type { VehicleOptions } from '../app/vehicleOptions';
import { makePolicy } from './fixtures';
import { editValuesOf, emptyValues, renewalValuesOf } from './formModel';
import { PolicyForm, type PolicyFormProps } from './PolicyForm';
import { PolicyNotEditable, PolicyNotFound } from './PolicyMessages';
import { Frame, noop } from './storyFrame';

export default {
  title: 'Flota/Seguros/Formulario',
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
const policy = makePolicy({
  coverageNotes: 'Incluye cristales.',
  version: 3,
  revision: 2,
  startsOn: '2025-10-04',
  endsOn: '2026-10-03',
  hasDeductible: true,
  deductible: { kind: 'amount', amountMinor: 1_250_000, currency: 'MXN' },
});

const create = (props: Partial<PolicyFormProps> = {}) => (
  <Frame>
    <PageHeader
      title="Nueva póliza"
      description="Registra la póliza de seguro de un vehículo y su vigencia."
    />
    <PolicyForm
      mode="create"
      canViewCosts
      vehicles={vehicles}
      cancelTo="/flota/seguros"
      onSubmit={noop}
      {...props}
    />
  </Frame>
);
const change = (mode: 'edit' | 'renew', props: Partial<PolicyFormProps> = {}) => (
  <Frame>
    <PageHeader title={mode === 'edit' ? 'Editar póliza' : 'Renovar póliza'} />
    <PolicyForm
      mode={mode}
      canViewCosts
      initial={mode === 'edit' ? editValuesOf(policy) : renewalValuesOf(policy)}
      policy={policy}
      vehicleName="ECO-001"
      cancelTo="/flota/seguros/pol-001"
      onSubmit={noop}
      {...props}
    />
  </Frame>
);

export const Create = { render: () => create() };
export const CreateWithoutCosts = { render: () => create({ canViewCosts: false }) };
export const CreateAmountDeductible = {
  render: () =>
    create({
      initial: {
        ...emptyValues,
        vehicleId: 'veh-001',
        insurer: 'Seguros Demo',
        policyNumber: 'POL-77',
        coverageType: 'comprehensive',
        startsOn: '2026-11-01',
        endsOn: '2027-10-31',
        deductibleKind: 'amount',
        deductibleAmount: '12500.50',
        deductibleCurrency: 'MXN',
      },
    }),
};
export const CreateInvalid = {
  render: () =>
    create({
      initial: {
        ...emptyValues,
        policyNumber: 'pol 77',
        startsOn: '2027-01-01',
        endsOn: '2026-01-01',
        deductibleKind: 'percent',
        deductiblePercent: '250',
      },
    }),
};
export const CreateWithServerError = {
  render: () =>
    create({
      initial: {
        ...emptyValues,
        vehicleId: 'veh-001',
        insurer: 'Seguros Demo',
        policyNumber: 'POL-77',
        coverageType: 'comprehensive',
        startsOn: '2026-11-01',
        endsOn: '2027-10-31',
      },
      serverErrors: {
        vehicleId: 'El vehículo no existe o está archivado. Elige otro de la lista.',
      },
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
        title: 'Otra persona modificó esta póliza',
        message: 'Carga los datos actuales para continuar; lo que escribiste se descartará.',
        actionLabel: 'Cargar datos actuales',
      },
      onAlertAction: noop,
    }),
};
export const Renew = { render: () => change('renew') };
export const RenewWithoutCosts = { render: () => change('renew', { canViewCosts: false }) };
export const NotFound = {
  render: () => (
    <Frame>
      <PolicyNotFound />
    </Frame>
  ),
};
export const NotEditable = {
  render: () => (
    <Frame>
      <PolicyNotEditable policyId="pol-001" />
    </Frame>
  ),
};
