import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  Button,
  DataTable,
  DetailTabs,
  Field,
  FormSection,
  Notifications,
  PageHeader,
  StatusBadge,
  UiState,
} from '@opslog/ui';
import { permissionLabels } from '../../app/permissions';
import { ScrollRegion } from '../../app/ScrollRegion';
import { ResourceView, useResource } from '../../app/resource';
import type { RoleSummary } from '../../app/types';
import { DraftNotice, useServerDraft } from '../../auth/drafts';
import { useSession } from '../../auth/session';

interface RoleRow extends RoleSummary {
  actions: string;
}

/** Roles screen: the system templates are read-only; a custom copy is created from any role. */
export function RolesScreen() {
  const { ports } = useSession();
  const { state, reload } = useResource(() => ports.roles.listRoles(), [ports]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Roles"
        description="Las plantillas del sistema no se pueden editar; crea una copia personalizada."
      />
      {created && (
        <Notifications
          messages={[{ id: 'created', text: `Rol "${created}" creado.`, severity: 'success' }]}
        />
      )}
      <ResourceView state={state} onRetry={reload}>
        {(roles) => {
          if (roles.length === 0) return <UiState kind="empty" title="Aún no hay roles" />;
          const selected = roles.find((role) => role.id === selectedId) ?? null;
          const rows: RoleRow[] = roles.map((role) => ({ ...role, actions: role.id }));
          return (
            <>
              <ScrollRegion label="Tabla de roles">
                <DataTable<RoleRow>
                  caption="Roles de la empresa"
                  columns={[
                    { key: 'name', label: 'Rol' },
                    {
                      key: 'kind',
                      label: 'Tipo',
                      render: (value) =>
                        value === 'system' ? (
                          <StatusBadge label="Plantilla del sistema" tone="neutral" />
                        ) : (
                          <StatusBadge label="Personalizado" tone="success" />
                        ),
                    },
                    { key: 'memberCount', label: 'Personas' },
                    {
                      key: 'actions',
                      label: 'Acciones',
                      render: (_, row) => (
                        <Button size="small" onClick={() => setSelectedId(row.id)}>
                          {`Ver ${row.name}`}
                        </Button>
                      ),
                    },
                  ]}
                  rows={rows}
                />
              </ScrollRegion>
              {selected && (
                <RoleDetail
                  key={selected.id}
                  role={selected}
                  onCreated={(role) => {
                    setCreated(role.name);
                    setSelectedId(role.id);
                    reload();
                  }}
                />
              )}
            </>
          );
        }}
      </ResourceView>
    </>
  );
}

function RoleDetail({
  role,
  onCreated,
}: {
  role: RoleSummary;
  onCreated: (role: RoleSummary) => void;
}) {
  const [tab, setTab] = React.useState('permissions');
  return (
    <Box component="section" aria-label={`Detalle de ${role.name}`} sx={{ mt: 3 }}>
      <Typography component="h2" variant="h2" sx={{ mb: 1 }}>
        {role.name}
      </Typography>
      <DetailTabs
        value={tab}
        onChange={setTab}
        tabs={[
          {
            id: 'permissions',
            label: 'Permisos',
            content: (
              <Box component="ul" aria-label={`Permisos de ${role.name}`} sx={{ pl: 3, m: 0 }}>
                {role.permissions.map((permission) => (
                  <li key={permission}>
                    <Typography>{permissionLabels[permission]}</Typography>
                  </li>
                ))}
              </Box>
            ),
          },
          {
            id: 'copy',
            label: 'Crear copia',
            content: <CopyForm role={role} onCreated={onCreated} />,
          },
        ]}
      />
    </Box>
  );
}

function CopyForm({
  role,
  onCreated,
}: {
  role: RoleSummary;
  onCreated: (role: RoleSummary) => void;
}) {
  const { ports, markExpired } = useSession();
  const draft = useServerDraft(`role-copy:${role.id}`, { name: '' });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.values.name.trim()) {
      setErrors({ name: 'Escribe un nombre.' });
      return;
    }
    setSubmitting(true);
    setErrors({});
    let result;
    try {
      result = await ports.roles.copyRole(role.id, draft.values.name);
    } catch {
      setErrors({ name: 'No pudimos crear la copia. Intenta nuevamente.' });
      return;
    } finally {
      setSubmitting(false);
    }
    if (result.ok) {
      onCreated(result.value);
      try {
        await draft.discard();
      } catch {
        // The draft is only a convenience; the next save replaces it.
      }
    } else if (result.error.status === 401) markExpired();
    else
      // The BFF answers with a uniform error and no per-field detail: a conflict can only be the name.
      setErrors({
        name:
          result.error.status === 409
            ? 'Ya existe un rol con ese nombre.'
            : 'No pudimos crear la copia. Intenta nuevamente.',
      });
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-label="Crear copia del rol">
      <FormSection
        title="Copia personalizada"
        description="La copia parte de los mismos permisos y pertenece solo a tu empresa."
      >
        <Field
          id="role-copy-name"
          label="Nombre del nuevo rol"
          required
          value={draft.values.name}
          onChange={(event) => {
            setErrors({});
            draft.setField('name', event.target.value);
          }}
          error={Boolean(errors.name)}
          helperText={errors.name}
        />
        <DraftNotice status={draft.status} />
        <Button type="submit" variant="contained" loading={submitting}>
          Crear copia
        </Button>
      </FormSection>
    </form>
  );
}
