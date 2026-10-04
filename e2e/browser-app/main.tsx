import React from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, Stack, ThemeProvider, Typography } from '@mui/material';
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
  StatusBadge,
  Timeline,
  UiState,
  UploadQueue,
  Wizard,
  opslogTheme,
} from '@opslog/ui';
import type { UploadItem } from '@opslog/ui';

type Row = { id: string; name: string; status: string };

function Gallery() {
  const [filter, setFilter] = React.useState('');
  const [selected, setSelected] = React.useState<string[]>([]);
  const [tab, setTab] = React.useState('summary');
  const [step, setStep] = React.useState(0);
  const [confirmedReason, setConfirmedReason] = React.useState('');
  const [retried, setRetried] = React.useState('');
  const [actioned, setActioned] = React.useState(false);
  const [uploads] = React.useState<UploadItem[]>([
    { id: 'uploading', name: 'reporte.csv', progress: 65, status: 'uploading' },
    { id: 'complete', name: 'resumen.pdf', progress: 100, status: 'complete' },
    { id: 'error', name: 'fallo.csv', progress: 0, status: 'error' },
  ]);
  const rows: Row[] = [
    { id: 'tenant-a', name: 'Tenant A', status: 'Activo' },
    { id: 'tenant-b', name: 'Tenant B', status: 'Pendiente' },
  ];

  return (
    <main>
      <PageHeader
        title="Galería de componentes OPSLOG"
        description="Harness browser con fixtures sintéticos"
        actions={<Button variant="outlined">Acción de cabecera</Button>}
      />
      <Stack spacing={4}>
        <section aria-labelledby="status-title">
          <Typography id="status-title" component="h2" variant="h5">
            StatusBadge
          </Typography>
          <StatusBadge
            label="Activo"
            tone="success"
            severity="Baja"
            description="Procesamiento normal"
          />
        </section>

        <section aria-labelledby="states-title">
          <Typography id="states-title" component="h2" variant="h5">
            UiState
          </Typography>
          <Stack spacing={1}>
            <UiState kind="loading" />
            <UiState kind="empty" />
            <UiState kind="no-results" />
            <UiState kind="no-permission" />
            <UiState kind="incomplete" />
            <UiState kind="expired" />
            <UiState kind="closed" />
            <UiState kind="success" />
            <UiState kind="session-expired" />
            <UiState
              kind="error"
              actionLabel="Reintentar estado"
              onAction={() => setActioned(true)}
            />
            {actioned && <Typography>Estado reintentado</Typography>}
          </Stack>
        </section>

        <section aria-labelledby="base-title">
          <Typography id="base-title" component="h2" variant="h5">
            BaseComponents
          </Typography>
          <Stack spacing={3}>
            <FormSection title="Formulario" description="Datos sintéticos de validación">
              <Field label="Nombre" id="name" description="Campo requerido" />
              <Button loading aria-label="Guardar cargando">
                Guardar
              </Button>
            </FormSection>

            <SeverityBadge severity="critical" />

            <FilterBar onClear={() => setFilter('')}>
              <Field
                label="Filtrar"
                id="filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </FilterBar>
            <Typography>Filtro actual: {filter || 'ninguno'}</Typography>

            <DataTable
              caption="Tenants sintéticos"
              columns={[
                { key: 'name', label: 'Nombre' },
                { key: 'status', label: 'Estado' },
              ]}
              rows={rows}
              selectable
              selected={selected}
              onSelectedChange={setSelected}
            />
            <Typography>Seleccionados: {selected.join(', ') || 'ninguno'}</Typography>

            <DetailTabs
              value={tab}
              onChange={setTab}
              tabs={[
                {
                  id: 'summary',
                  label: 'Resumen',
                  content: <Typography>Resumen visible</Typography>,
                },
                {
                  id: 'history',
                  label: 'Historial',
                  content: <Typography>Historial visible</Typography>,
                },
              ]}
            />
            <Wizard
              steps={['Preparar', 'Validar', 'Completar']}
              activeStep={step}
              onStepChange={setStep}
            />
            <Typography>Paso actual: {step + 1}</Typography>

            <Timeline
              items={[
                { id: 'created', title: 'Creado', date: '2026-10-04' },
                {
                  id: 'validated',
                  title: 'Validado',
                  description: 'Fixture sintético',
                  date: '2026-10-04',
                },
              ]}
            />
            <NextStepPanel title="Siguiente paso" steps={['Revisar', 'Aprobar']} />
            <ConfirmWithReason
              title="Confirmar cambio"
              onConfirm={setConfirmedReason}
              onCancel={() => setConfirmedReason('cancelado')}
            />
            {confirmedReason && <Typography>Motivo confirmado: {confirmedReason}</Typography>}

            <UploadQueue items={uploads} onRetry={setRetried} />
            {retried && <Typography>Reintento solicitado: {retried}</Typography>}
            <Notifications
              messages={[
                { id: 'info', text: 'Información sintética', severity: 'info' },
                { id: 'success', text: 'Operación completada', severity: 'success' },
              ]}
            />
          </Stack>
        </section>
      </Stack>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider theme={opslogTheme}>
      <CssBaseline />
      <Gallery />
    </ThemeProvider>
  </React.StrictMode>,
);
