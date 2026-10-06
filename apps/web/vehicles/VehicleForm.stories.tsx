import React from 'react';
import { PageHeader, UiState } from '@opslog/ui';
import { makeVehicle } from './fixtures';
import { validate, valuesOf, type VehicleFormValues } from './formModel';
import { Frame, noop, storyNow } from './storyFrame';
import { VehicleForm, type VehicleFormProps } from './VehicleForm';
import { VehicleNotEditable, VehicleNotFound } from './VehicleMessages';

export default {
  title: 'Flota/Vehiculos/Formulario',
  parameters: { layout: 'padded' },
};

const vehicle = makeVehicle({ vin: '3N6PD23W05ZB10005', odometerKm: 48250, version: 3 });

const create = (props: Partial<VehicleFormProps> = {}) => (
  <Frame>
    <PageHeader
      title="Nuevo vehículo"
      description="El vehículo se crea con estado Activo y la fecha de alta que indiques."
    />
    <VehicleForm
      mode="create"
      cancelTo="/flota/vehiculos"
      onSubmit={noop}
      now={storyNow}
      {...props}
    />
  </Frame>
);

const edit = (props: Partial<VehicleFormProps> = {}) => (
  <Frame>
    <PageHeader
      title="Editar vehículo"
      description="Los cambios se guardan sobre la versión que cargaste; si otra persona cambia el vehículo antes, te avisaremos."
    />
    <VehicleForm
      mode="edit"
      initial={valuesOf(vehicle)}
      currentOdometerKm={vehicle.odometerKm}
      cancelTo="/flota/vehiculos/veh-001"
      onSubmit={noop}
      now={storyNow}
      {...props}
    />
  </Frame>
);

const invalid: VehicleFormValues = {
  economicNumber: '',
  plate: 'AB*123',
  vin: '1HGBH41JXMN1O9186',
  make: 'Nissan',
  model: '',
  year: '1899',
  areaId: 'área norte',
  odometerKm: '-5',
  registeredOn: '2027-01-01',
};

export const Create = { render: () => create() };
export const CreateValidationErrors = {
  render: () =>
    create({
      initial: invalid,
      serverErrors: validate(invalid, { mode: 'create', now: storyNow }),
    }),
};
export const CreateDuplicates = {
  render: () =>
    create({
      initial: {
        economicNumber: 'ECO-001',
        plate: 'ABC-101',
        vin: '',
        make: 'Nissan',
        model: 'NP300',
        year: '2022',
        areaId: 'area-norte',
        odometerKm: '48250',
        registeredOn: '2026-10-06',
      },
      serverErrors: {
        economicNumber: 'Ya existe un vehículo con este número económico.',
        plate: 'Ya existe un vehículo con esta placa.',
      },
      alert: {
        severity: 'error',
        title: 'Hay datos que ya existen',
        message: 'Otro vehículo de tu empresa usa el mismo valor. Corrige los campos marcados.',
      },
    }),
};
export const CreateSaving = { render: () => create({ submitting: true }) };
export const Edit = { render: () => edit() };
export const EditSaving = { render: () => edit({ submitting: true }) };
export const EditVersionConflict = {
  render: () =>
    edit({
      alert: {
        severity: 'error',
        title: 'Otra persona modificó este vehículo',
        message:
          'Cambió mientras lo editabas. Tus cambios no se guardaron. Carga los datos actuales y vuelve a hacer tus cambios.',
        actionLabel: 'Cargar datos actuales',
      },
      onAlertAction: noop,
    }),
};
export const EditOdometerDecrease = {
  render: () =>
    edit({
      initial: { ...valuesOf(vehicle), odometerKm: '41000' },
      serverErrors: {
        odometerKm: 'El odómetro no puede ser menor a la lectura que ya está registrada.',
      },
      alert: {
        severity: 'error',
        title: 'Lectura de odómetro rechazada',
        message:
          'El servidor ya tiene una lectura mayor, quizá registrada por otra persona. Los demás datos del vehículo sí se guardaron. Carga los datos actuales para ver la última lectura.',
        actionLabel: 'Cargar datos actuales',
      },
      onAlertAction: noop,
    }),
};
export const EditNotEditable = {
  render: () => (
    <Frame>
      <PageHeader title="Editar vehículo" />
      <VehicleNotEditable vehicleId="veh-001" />
    </Frame>
  ),
};
export const EditNotFound = {
  render: () => (
    <Frame>
      <PageHeader title="Editar vehículo" />
      <VehicleNotFound />
    </Frame>
  ),
};
export const NoPermission = {
  render: () => (
    <Frame>
      <UiState kind="no-permission" />
    </Frame>
  ),
};
