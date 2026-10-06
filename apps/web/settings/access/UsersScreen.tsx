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
import { useRouter } from '../../app/router';
import type { InvitationIssued, RoleSummary, UserStatus, UserSummary } from '../../app/types';
import { DraftNotice, useServerDraft } from '../../auth/drafts';
import { useSession } from '../../auth/session';

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
  const [issued, setIssued] = React.useState<InvitationIssued | null>(null);
  const [notice, setNotice] = React.useState<{
    text: string;
    severity: 'success' | 'error';
  } | null>(null);

  React.useEffect(() => setExtra(null), [search, first.state]);
  // A one-time invitation token must not outlive the session that issued it.
  React.useEffect(() => {
    if (sessionState.status === 'expired') setIssued(null);
  }, [sessionState.status]);

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
      setNotice({ text: `La cuenta ${result.value.id} fue desactivada.`, severity: 'success' });
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
            label="Buscar por identificador, rol o estado"
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
                    { key: 'id', label: 'Identificador' },
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
                            {`Desactivar a ${row.id}`}
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
          title={`Desactivar a ${target.id}`}
          reasonLabel="Motivo de la desactivación"
          onConfirm={(reason) => void deactivate(reason)}
          onCancel={() => setTarget(null)}
        />
      )}
      {roles.state.status === 'ready' && (
        <InviteForm
          roles={roles.state.data}
          onInviteStarted={() => setIssued(null)}
          onInvited={(invitation) => {
            setIssued(invitation);
            setNotice({ text: 'Invitación creada.', severity: 'success' });
            first.reload();
          }}
        />
      )}
      {issued && <IssuedInvitation invitation={issued} />}
    </>
  );
}

/** Email delivery is not built yet: the administrator receives the one-time link and hands it over. */
function IssuedInvitation({ invitation }: { invitation: InvitationIssued }) {
  const router = useRouter();
  const link = `${window.location.origin}${router.basename}/invitacion/${encodeURIComponent(
    invitation.invitationToken,
  )}`;
  return (
    <FormSection
      title="Enlace de invitación"
      description={`Compártelo con la persona invitada por un canal seguro. Solo se muestra ahora, se puede usar una vez y vence el ${new Date(invitation.expiresAt).toLocaleString('es-MX')}.`}
    >
      <Field
        id="invitation-link"
        label="Enlace de invitación"
        value={link}
        InputProps={{ readOnly: true }}
        onFocus={(event) => event.target.select()}
      />
    </FormSection>
  );
}

function InviteForm({
  roles,
  onInvited,
  onInviteStarted,
}: {
  roles: readonly RoleSummary[];
  onInviteStarted: () => void;
  onInvited: (invitation: InvitationIssued) => void;
}) {
  const { ports, markExpired } = useSession();
  const draft = useServerDraft('invite-user', { roleId: '' });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);
  const { values, setField } = draft;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!values.roleId) {
      setErrors({ roleId: 'Elige un rol de la lista.' });
      return;
    }
    setSubmitting(true);
    setErrors({});
    onInviteStarted();
    const failed = () =>
      setErrors({ roleId: 'No pudimos crear la invitación. Intenta nuevamente.' });
    let result;
    try {
      result = await ports.users.inviteUser({ roleId: values.roleId });
    } catch {
      failed();
      return;
    } finally {
      setSubmitting(false);
    }
    if (result.ok) {
      // The one-time token must reach the administrator even if clearing the draft fails.
      onInvited(result.value);
      try {
        await draft.discard();
      } catch {
        // The draft is only a convenience; the next save replaces it.
      }
    } else if (result.error.status === 401) markExpired();
    else failed();
  };

  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-label="Invitar usuario">
      <FormSection
        title="Invitar a una persona"
        description="La invitación vence en 72 horas y solo se puede usar una vez."
      >
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
          Crear invitación
        </Button>
      </FormSection>
    </form>
  );
}
