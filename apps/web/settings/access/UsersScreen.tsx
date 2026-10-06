import React from 'react';
import {
  Button,
  ConfirmWithReason,
  DataTable,
  Field,
  FilterBar,
  FormSection,
  Notifications,
  PageHeader,
  StatusBadge,
  UiState,
} from '@opslog/ui';
import { ScrollRegion } from '../../app/ScrollRegion';
import { NoSubmit, ResourceView, useResource } from '../../app/resource';
import type { RoleSummary, UserStatus, UserSummary } from '../../app/types';
import { DraftNotice, useServerDraft } from '../../auth/drafts';
import { fieldErrorMap, useSession } from '../../auth/session';

const statusPresentation: Record<
  UserStatus,
  { label: string; tone: 'success' | 'warning' | 'neutral' }
> = {
  active: { label: 'Activo', tone: 'success' },
  invited: { label: 'Invitación pendiente', tone: 'warning' },
  inactive: { label: 'Desactivado', tone: 'neutral' },
};

interface UserRow extends UserSummary {
  actions: string;
}

/** Users screen: list, search, invite and deactivate. Requires `manage_users`. */
export function UsersScreen() {
  const { ports, state: sessionState, markExpired } = useSession();
  const [search, setSearch] = React.useState('');
  const currentUserId =
    sessionState.status === 'authenticated' || sessionState.status === 'expired'
      ? sessionState.session.user.id
      : '';
  const first = useResource(() => ports.users.listUsers({ limit: 25, search }), [ports, search]);
  const roles = useResource(() => ports.roles.listRoles(), [ports]);
  const [extra, setExtra] = React.useState<{ items: UserSummary[]; cursor: string | null } | null>(
    null,
  );
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [target, setTarget] = React.useState<UserSummary | null>(null);
  const [notice, setNotice] = React.useState<{
    text: string;
    severity: 'success' | 'error';
  } | null>(null);

  React.useEffect(() => setExtra(null), [search, first.state]);

  const searchRef = React.useRef(search);
  searchRef.current = search;

  const loadMore = async (cursor: string) => {
    setLoadingMore(true);
    const requested = search;
    const result = await ports.users.listUsers({ limit: 25, cursor, search: requested });
    setLoadingMore(false);
    // The filter changed while this page was loading: its rows belong to a different search.
    if (searchRef.current !== requested) return;
    if (result.ok)
      setExtra((current) => ({
        items: [...(current?.items ?? []), ...result.value.items],
        cursor: result.value.nextCursor,
      }));
    else if (result.error.status === 401) markExpired();
    else setNotice({ text: 'No pudimos cargar más usuarios.', severity: 'error' });
  };

  const deactivate = async (reason: string) => {
    if (!target) return;
    const result = await ports.users.deactivateUser(target.id, reason);
    setTarget(null);
    if (result.ok) {
      setNotice({ text: `${result.value.displayName} fue desactivado.`, severity: 'success' });
      first.reload();
    } else if (result.error.status === 401) markExpired();
    else
      setNotice({
        text: 'No pudimos desactivar a la persona. Intenta nuevamente.',
        severity: 'error',
      });
  };

  return (
    <>
      <PageHeader title="Usuarios" description="Personas con acceso a tu empresa." />
      {notice && (
        <Notifications
          messages={[{ id: 'notice', text: notice.text, severity: notice.severity }]}
        />
      )}
      <NoSubmit>
        <FilterBar onClear={() => setSearch('')}>
          <Field
            id="users-search"
            label="Buscar por nombre o correo"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </FilterBar>
      </NoSubmit>
      <ResourceView state={first.state} onRetry={first.reload}>
        {(page) => {
          const items = [...page.items, ...(extra?.items ?? [])];
          const cursor = extra ? extra.cursor : page.nextCursor;
          if (items.length === 0)
            return search ? (
              <UiState kind="no-results" />
            ) : (
              <UiState
                kind="empty"
                title="Aún no hay usuarios"
                description="Invita a tu equipo para que pueda entrar."
              />
            );
          const rows: UserRow[] = items.map((user) => ({ ...user, actions: user.id }));
          return (
            <>
              <ScrollRegion label="Tabla de usuarios">
                <DataTable<UserRow>
                  caption={`Usuarios (${page.total})`}
                  columns={[
                    { key: 'displayName', label: 'Nombre' },
                    { key: 'email', label: 'Correo' },
                    { key: 'roleLabel', label: 'Rol' },
                    {
                      key: 'status',
                      label: 'Estado',
                      render: (value) => {
                        const view = statusPresentation[value as UserStatus];
                        return <StatusBadge label={view.label} tone={view.tone} />;
                      },
                    },
                    {
                      key: 'actions',
                      label: 'Acciones',
                      render: (_, row) =>
                        row.status === 'inactive' || row.id === currentUserId ? null : (
                          <Button size="small" onClick={() => setTarget(row)}>
                            {`Desactivar a ${row.displayName}`}
                          </Button>
                        ),
                    },
                  ]}
                  rows={rows}
                />
              </ScrollRegion>
              {cursor && (
                <Button
                  variant="outlined"
                  loading={loadingMore}
                  onClick={() => void loadMore(cursor)}
                >
                  Cargar más usuarios
                </Button>
              )}
            </>
          );
        }}
      </ResourceView>
      {target && (
        <ConfirmWithReason
          title={`Desactivar a ${target.displayName}`}
          reasonLabel="Motivo de la desactivación"
          onConfirm={(reason) => void deactivate(reason)}
          onCancel={() => setTarget(null)}
        />
      )}
      {roles.state.status === 'ready' && (
        <InviteForm
          roles={roles.state.data}
          onInvited={(user) => {
            setNotice({ text: `Invitación enviada a ${user.email}.`, severity: 'success' });
            first.reload();
          }}
        />
      )}
    </>
  );
}

function InviteForm({
  roles,
  onInvited,
}: {
  roles: readonly RoleSummary[];
  onInvited: (user: UserSummary) => void;
}) {
  const { ports, markExpired } = useSession();
  const draft = useServerDraft('invite-user', { email: '', roleId: '' });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);
  const { values, setField } = draft;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setErrors({});
    const result = await ports.users.inviteUser({ email: values.email, roleId: values.roleId });
    setSubmitting(false);
    if (result.ok) {
      await draft.discard();
      onInvited(result.value);
    } else if (result.error.status === 401) markExpired();
    else setErrors(fieldErrorMap(result.error));
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-label="Invitar usuario">
      <FormSection
        title="Invitar a una persona"
        description="La invitación vence en 72 horas y solo se puede usar una vez."
      >
        <Field
          id="invite-email"
          label="Correo de la persona"
          type="email"
          required
          value={values.email}
          onChange={(event) => setField('email', event.target.value)}
          error={Boolean(errors.email)}
          helperText={errors.email}
        />
        <Field
          id="invite-role"
          label="Rol"
          select
          required
          SelectProps={{ native: true }}
          InputLabelProps={{ shrink: true }}
          value={values.roleId}
          onChange={(event) => setField('roleId', event.target.value)}
          error={Boolean(errors.roleId)}
          helperText={errors.roleId}
        >
          <option value="">Elige un rol</option>
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </Field>
        <DraftNotice status={draft.status} />
        <Button type="submit" variant="contained" loading={submitting}>
          Enviar invitación
        </Button>
      </FormSection>
    </form>
  );
}
