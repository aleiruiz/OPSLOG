import type { Meta, StoryObj } from '@storybook/react';
import {
  Button,
  ConfirmWithReason,
  DataTable,
  DetailTabs,
  Field,
  FilterBar,
  FormSection,
  NextStepPanel,
  Notifications,
  PageHeader,
  SeverityBadge,
  Timeline,
  UploadQueue,
  Wizard,
} from './BaseComponents';

const meta = {
  title: 'Foundations/Componentes base',
  parameters: { layout: 'padded' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ActionsAndFields: Story = {
  render: () => (
    <FormSection title="Datos del registro" description="Los campos marcados son obligatorios.">
      <Field label="Nombre" required />
      <Button variant="contained">Guardar</Button>
      <SeverityBadge severity="high" />
    </FormSection>
  ),
};
export const NavigationAndFeedback: Story = {
  render: () => (
    <>
      <PageHeader
        title="Incidentes"
        description="Consulta y seguimiento de casos."
        actions={<Button variant="contained">Nuevo incidente</Button>}
      />
      <FilterBar onClear={() => undefined}>
        <Field label="Buscar" />
      </FilterBar>
      <DetailTabs
        tabs={[
          { id: 'summary', label: 'Resumen', content: <p>Resumen sintético.</p> },
          { id: 'history', label: 'Historial', content: <p>Historial sintético.</p> },
        ]}
        value="summary"
        onChange={() => undefined}
      />
      <Wizard
        steps={['Datos', 'Evidencia', 'Confirmación']}
        activeStep={1}
        onStepChange={() => undefined}
      />
      <Notifications
        messages={[{ id: 'saved', text: 'Cambios guardados.', severity: 'success' }]}
      />
    </>
  ),
};
export const DataAndWorkflow: Story = {
  render: () => (
    <>
      <DataTable
        columns={[
          { key: 'name', label: 'Nombre' },
          { key: 'status', label: 'Estado' },
        ]}
        rows={[{ id: 'synthetic-1', name: 'Registro sintético', status: 'Activo' }]}
        selectable
      />
      <Timeline
        items={[
          {
            id: 'event-1',
            title: 'Registro creado',
            date: 'Hoy',
            description: 'Evento sintético para la story.',
          },
        ]}
      />
      <NextStepPanel steps={['Revisar evidencia', 'Confirmar cierre']} />
      <UploadQueue
        items={[
          { id: 'upload-1', name: 'evidencia.pdf', progress: 60, status: 'uploading' },
          { id: 'upload-2', name: 'foto.jpg', progress: 100, status: 'complete' },
          { id: 'upload-3', name: 'documento.docx', progress: 0, status: 'error' },
        ]}
      />
      <UploadQueue
        items={[{ id: 'upload-4', name: 'sin-reintento.pdf', progress: 0, status: 'error' }]}
      />
      <UploadQueue
        items={[{ id: 'upload-5', name: 'con-reintento.pdf', progress: 0, status: 'error' }]}
        onRetry={() => undefined}
      />
    </>
  ),
};
export const Confirmation: Story = {
  render: () => <ConfirmWithReason onConfirm={() => undefined} onCancel={() => undefined} />,
};
