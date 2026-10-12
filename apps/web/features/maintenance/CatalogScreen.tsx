import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import {
  Button,
  DataTable,
  Field,
  FormSection,
  PageHeader,
  StatusBadge,
  UiState,
} from '@opslog/ui';
import type { BffMaintenanceMechanic, BffMaintenanceWorkshop } from '@opslog/contracts';
import type { MaintenancePorts, Result } from './ports';
import { errorKind, useResult } from './useResult';
import type { MaintenanceViewer } from './workflow';

/** A member of the same company, offered for linking an internal mechanic (never created here). */
export interface MemberOption {
  readonly id: string;
  readonly label: string;
}

const active = (value: boolean) => (
  <StatusBadge label={value ? 'Activo' : 'Inactivo'} tone={value ? 'success' : 'neutral'} />
);
const split = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/** FR-095/096: workshops and mechanics of the company. External mechanics never get an account. */
export function CatalogScreen({
  ports,
  viewer,
  members = [],
  onExpired,
}: {
  ports: MaintenancePorts;
  viewer: MaintenanceViewer;
  members?: readonly MemberOption[];
  onExpired: () => void;
}) {
  const workshops = useResult(() => ports.workshops.list(), [ports], onExpired);
  const mechanics = useResult(() => ports.mechanics.list(), [ports], onExpired);
  const [notice, setNotice] = React.useState<string | null>(null);
  const canCreate = viewer.permissions.includes('create');
  const canEdit = viewer.permissions.includes('edit');
  const act = async <T,>(call: () => Promise<Result<T>>, reload: () => void) => {
    const result = await call();
    if (result.ok) {
      setNotice(null);
      reload();
      return true;
    }
    if (result.error.status === 401) onExpired();
    setNotice(
      result.error.status === 409
        ? 'El taller o la persona elegida no está disponible en tu empresa.'
        : result.error.status === 403
          ? 'No tienes permiso para esta acción.'
          : 'No pudimos guardar el cambio. Intenta nuevamente.',
    );
    return false;
  };
  if (workshops.state.status === 'loading' || mechanics.state.status === 'loading')
    return <UiState kind="loading" />;
  if (workshops.state.status === 'error')
    return (
      <UiState
        kind={errorKind(workshops.state.error)}
        actionLabel="Reintentar"
        onAction={workshops.reload}
      />
    );
  if (mechanics.state.status === 'error')
    return (
      <UiState
        kind={errorKind(mechanics.state.error)}
        actionLabel="Reintentar"
        onAction={mechanics.reload}
      />
    );
  const workshopRows = workshops.state.data;
  const mechanicRows = mechanics.state.data;
  return (
    <Box>
      <PageHeader
        title="Talleres y mecánicos"
        description="Catálogo de tu empresa para asignar órdenes."
      />
      {notice && (
        <Alert severity="error" role="alert" sx={{ mb: 2 }}>
          {notice}
        </Alert>
      )}
      <Stack spacing={4}>
        <Box component="section" aria-labelledby="mnt-workshops-title">
          <Typography id="mnt-workshops-title" component="h2" variant="h5">
            Talleres
          </Typography>
          {canCreate && (
            <WorkshopForm
              onSubmit={(body) => act(() => ports.workshops.create(body), workshops.reload)}
            />
          )}
          {workshopRows.length === 0 ? (
            <UiState kind="empty" title="Aún no hay talleres" />
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <DataTable<BffMaintenanceWorkshop & { actions: null }>
                caption={`${workshopRows.length} talleres`}
                rows={workshopRows.map((w) => ({ ...w, actions: null }))}
                columns={[
                  { key: 'name', label: 'Nombre' },
                  {
                    key: 'specialties',
                    label: 'Especialidades',
                    render: (_v, row) => row.specialties.join(', ') || 'Sin especialidad',
                  },
                  {
                    key: 'contact',
                    label: 'Contacto',
                    render: (_v, row) => row.contact ?? 'Sin contacto',
                  },
                  { key: 'active', label: 'Estado', render: (_v, row) => active(row.active) },
                  {
                    key: 'actions',
                    label: 'Acciones',
                    render: (_v, row) =>
                      canEdit && row.active ? (
                        <Button
                          size="small"
                          onClick={() =>
                            act(() => ports.workshops.deactivate(row.id), workshops.reload)
                          }
                        >
                          Desactivar {row.name}
                        </Button>
                      ) : null,
                  },
                ]}
              />
            </Box>
          )}
        </Box>
        <Box component="section" aria-labelledby="mnt-mechanics-title">
          <Typography id="mnt-mechanics-title" component="h2" variant="h5">
            Mecánicos
          </Typography>
          {canCreate && (
            <MechanicForm
              workshops={workshopRows.filter((w) => w.active)}
              members={members}
              onSubmit={(body) => act(() => ports.mechanics.create(body), mechanics.reload)}
            />
          )}
          {mechanicRows.length === 0 ? (
            <UiState kind="empty" title="Aún no hay mecánicos" />
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <DataTable<BffMaintenanceMechanic & { actions: null }>
                caption={`${mechanicRows.length} mecánicos`}
                rows={mechanicRows.map((m) => ({ ...m, actions: null }))}
                columns={[
                  { key: 'name', label: 'Nombre' },
                  {
                    key: 'kind',
                    label: 'Vínculo',
                    render: (_v, row) =>
                      row.kind === 'internal'
                        ? 'Interno (usuario de la empresa)'
                        : 'Externo (sin cuenta)',
                  },
                  {
                    key: 'workshopId',
                    label: 'Taller',
                    render: (_v, row) =>
                      workshopRows.find((w) => w.id === row.workshopId)?.name ?? 'Sin taller',
                  },
                  { key: 'active', label: 'Estado', render: (_v, row) => active(row.active) },
                  {
                    key: 'actions',
                    label: 'Acciones',
                    render: (_v, row) =>
                      canEdit && row.active ? (
                        <Button
                          size="small"
                          onClick={() =>
                            act(() => ports.mechanics.deactivate(row.id), mechanics.reload)
                          }
                        >
                          Desactivar {row.name}
                        </Button>
                      ) : null,
                  },
                ]}
              />
            </Box>
          )}
        </Box>
      </Stack>
    </Box>
  );
}

function WorkshopForm({
  onSubmit,
}: {
  onSubmit: (body: {
    name: string;
    specialties: string[];
    contact: string | null;
  }) => Promise<boolean>;
}) {
  const [name, setName] = React.useState('');
  const [specialties, setSpecialties] = React.useState('');
  const [contact, setContact] = React.useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    if (
      await onSubmit({
        name: name.trim(),
        specialties: split(specialties),
        contact: contact.trim() || null,
      })
    ) {
      setName('');
      setSpecialties('');
      setContact('');
    }
  };
  return (
    <Card
      component="form"
      noValidate
      aria-label="Nuevo taller"
      onSubmit={submit}
      sx={{ p: 2, my: 2 }}
    >
      <FormSection title="Nuevo taller">
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
          <Field
            id="mnt-ws-name"
            label="Nombre del taller"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Field
            id="mnt-ws-specialties"
            label="Especialidades del taller (separadas por coma)"
            value={specialties}
            onChange={(e) => setSpecialties(e.target.value)}
          />
          <Field
            id="mnt-ws-contact"
            label="Contacto"
            value={contact}
            onChange={(e) => setContact(e.target.value)}
          />
        </Stack>
        <Box>
          <Button type="submit" variant="contained">
            Agregar taller
          </Button>
        </Box>
      </FormSection>
    </Card>
  );
}

function MechanicForm({
  workshops,
  members,
  onSubmit,
}: {
  workshops: readonly BffMaintenanceWorkshop[];
  members: readonly MemberOption[];
  onSubmit: (body: {
    name: string;
    specialties: string[];
    kind: 'internal' | 'external';
    workshopId: string | null;
    memberId: string | null;
  }) => Promise<boolean>;
}) {
  const [name, setName] = React.useState('');
  const [specialties, setSpecialties] = React.useState('');
  const [kind, setKind] = React.useState<'internal' | 'external'>('external');
  const [workshopId, setWorkshopId] = React.useState('');
  const [memberId, setMemberId] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || (kind === 'internal' && !memberId)) {
      setError(
        kind === 'internal'
          ? 'Elige el usuario de la empresa que es este mecánico.'
          : 'Escribe el nombre.',
      );
      return;
    }
    setError(null);
    const saved = await onSubmit({
      name: name.trim(),
      specialties: split(specialties),
      kind,
      workshopId: workshopId || null,
      memberId: kind === 'internal' ? memberId : null,
    });
    if (saved) {
      setName('');
      setSpecialties('');
      setMemberId('');
    }
  };
  return (
    <Card
      component="form"
      noValidate
      aria-label="Nuevo mecánico"
      onSubmit={submit}
      sx={{ p: 2, my: 2 }}
    >
      <FormSection
        title="Nuevo mecánico"
        description="Un mecánico externo no tiene cuenta: registra su trabajo quien inicia sesión."
      >
        {error && (
          <Alert severity="error" role="alert">
            {error}
          </Alert>
        )}
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
          <Field
            id="mnt-mec-name"
            label="Nombre del mecánico"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Field
            id="mnt-mec-specialties"
            label="Especialidades del mecánico (separadas por coma)"
            value={specialties}
            onChange={(e) => setSpecialties(e.target.value)}
          />
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} gap={2}>
          <Field
            select
            id="mnt-mec-kind"
            label="Vínculo"
            value={kind}
            onChange={(e) => setKind(e.target.value as 'internal' | 'external')}
          >
            <MenuItem value="external">Externo (sin cuenta)</MenuItem>
            <MenuItem value="internal" disabled={members.length === 0}>
              Interno (usuario de la empresa)
            </MenuItem>
          </Field>
          {kind === 'internal' && (
            <Field
              select
              id="mnt-mec-member"
              label="Usuario de la empresa"
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
            >
              {members.map((m) => (
                <MenuItem key={m.id} value={m.id}>
                  {m.label}
                </MenuItem>
              ))}
            </Field>
          )}
          <Field
            select
            id="mnt-mec-workshop"
            label="Taller"
            value={workshopId}
            onChange={(e) => setWorkshopId(e.target.value)}
          >
            <MenuItem value="">Sin taller</MenuItem>
            {workshops.map((w) => (
              <MenuItem key={w.id} value={w.id}>
                {w.name}
              </MenuItem>
            ))}
          </Field>
        </Stack>
        <Box>
          <Button type="submit" variant="contained">
            Agregar mecánico
          </Button>
        </Box>
      </FormSection>
    </Card>
  );
}
