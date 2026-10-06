import React from 'react';
import { PageHeader } from '@opslog/ui';
import { areaChoices } from '../areas/areaChoices';
import { demoAreas } from '../areas/fixtures';
import { EmployeeForm, type EmployeeFormProps } from './EmployeeForm';
import { EmployeeNotEditable, EmployeeNotFound } from './EmployeeMessages';
import { makeEmployeeDetail } from './fixtures';
import { emptyValues, validate, valuesOf, type EmployeeFormValues } from './formModel';
import { Frame, noop, storyNow } from './storyFrame';

export default {
  title: 'Plantilla/Empleados/Formulario',
  parameters: { layout: 'padded' },
};

const areas = areaChoices(demoAreas());
const employee = makeEmployeeDetail({ version: 3 });

const create = (props: Partial<EmployeeFormProps> = {}) => (
  <Frame>
    <PageHeader
      title="Nuevo empleado"
      description="El empleado se crea con estado Activo. Después podrás cambiar su estado con un motivo."
    />
    <EmployeeForm
      mode="create"
      areas={areas}
      canEditPii
      cancelTo="/plantilla/empleados"
      onSubmit={noop}
      now={storyNow}
      {...props}
    />
  </Frame>
);

const edit = (props: Partial<EmployeeFormProps> = {}) => (
  <Frame>
    <PageHeader
      title="Editar empleado"
      description="Los cambios se guardan sobre la versión que cargaste; si otra persona cambia al empleado antes, te avisaremos."
    />
    <EmployeeForm
      mode="edit"
      areas={areas}
      canEditPii
      initial={valuesOf(employee)}
      cancelTo="/plantilla/empleados/emp-001"
      onSubmit={noop}
      now={storyNow}
      {...props}
    />
  </Frame>
);

const invalid: EmployeeFormValues = {
  ...emptyValues(),
  kind: 'driver',
  firstName: 'R0sa',
  employeeNumber: '¡mal!',
  hireDate: '2999-01-01',
  licenseType: '***',
  nationalId: 'ABCD1234',
  phone: '555',
  email: 'no-es-correo',
};
const filled: EmployeeFormValues = {
  ...emptyValues(),
  kind: 'driver',
  firstName: 'Rosa',
  lastName: 'Vega Luna',
  employeeNumber: 'E-0001',
  areaId: 'area-norte',
  idType: 'curp',
  nationalId: 'EJEM800101HDFXXX01',
  email: 'empleado1@ejemplo.test',
};
const staleAlert = {
  severity: 'error',
  title: 'Otra persona modificó este empleado',
  message:
    'Cambió mientras lo editabas. Tus cambios no se guardaron. Carga los datos actuales y vuelve a hacer tus cambios.',
  actionLabel: 'Cargar datos actuales',
} as const;

export const Create = { render: () => create() };
export const CreateDriver = {
  render: () => create({ initial: { ...emptyValues(), kind: 'driver' } }),
};
export const CreateValidationErrors = {
  render: () =>
    create({
      initial: invalid,
      serverErrors: validate(invalid, { mode: 'create', now: storyNow, canEditPii: true }),
    }),
};
export const CreateDuplicates = {
  render: () =>
    create({
      initial: filled,
      serverErrors: {
        employeeNumber: 'Ya existe un empleado con este número.',
        nationalId: 'Ya existe un empleado con esta identificación.',
        email: 'Ya existe un empleado con este correo.',
      },
      alert: {
        severity: 'error',
        title: 'Hay datos que ya existen',
        message: 'Otro empleado de tu empresa usa el mismo valor. Corrige los campos marcados.',
      },
    }),
};
export const CreateInvalidArea = {
  render: () =>
    create({
      initial: { ...filled, areaId: 'area-inexistente' },
      serverErrors: { areaId: 'El área no existe o está inactiva.' },
      alert: {
        severity: 'error',
        title: 'El área no es válida',
        message: 'El área no existe o está inactiva. Elige un área activa de tu empresa.',
      },
    }),
};
export const CreateWithoutPersonalDataAccess = {
  render: () => create({ canEditPii: false, initial: { ...emptyValues(), kind: 'driver' } }),
};
export const CreateNoAreas = { render: () => create({ areas: [] }) };
export const CreateSaving = { render: () => create({ submitting: true, initial: filled }) };
export const Edit = { render: () => edit() };
export const EditWithoutPersonalDataAccess = {
  render: () =>
    edit({
      canEditPii: false,
      initial: valuesOf({ ...employee, pii: null }),
      piiPresent: employee.piiPresent,
    }),
};
export const EditWithoutPersonalDataOnFile = {
  render: () =>
    edit({
      canEditPii: false,
      initial: valuesOf({ ...employee, pii: null }),
      piiPresent: { nationalId: false, phone: false, email: false, licenseNumber: false },
    }),
};
export const EditSaving = { render: () => edit({ submitting: true }) };
export const EditNothingToSave = {
  render: () => edit({ alert: { severity: 'info', message: 'No hay cambios que guardar.' } }),
};
export const EditVersionConflict = {
  render: () => edit({ alert: staleAlert, onAlertAction: noop }),
};
export const EditEmployeeClosed = {
  render: () =>
    edit({
      alert: {
        severity: 'error',
        title: 'El empleado ya no admite cambios',
        message: 'Se dio de baja o se archivó mientras lo editabas. Tus cambios no se guardaron.',
      },
    }),
};
export const EditOutdatedDraft = {
  render: () =>
    edit({
      alert: {
        severity: 'warning',
        message:
          'El empleado cambió desde que empezaste a editar. Cargamos los datos actuales: vuelve a hacer tus cambios.',
      },
    }),
};
export const NotEditable = {
  render: () => (
    <Frame>
      <PageHeader title="Editar empleado" />
      <EmployeeNotEditable employeeId="emp-007" />
    </Frame>
  ),
};
export const NotFound = {
  render: () => (
    <Frame>
      <PageHeader title="Editar empleado" />
      <EmployeeNotFound />
    </Frame>
  ),
};
