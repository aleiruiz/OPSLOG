import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, Field, FormSection, PageHeader, UiState } from '@opslog/ui';
import type { InvitationPreview, Result } from '../app/types';
import { useRouter } from '../app/router';
import { fieldErrorMap, useSession } from './session';

export const minimumPasswordLength = 12;

type Preview =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly preview: InvitationPreview }
  | { readonly status: 'unavailable' }
  | { readonly status: 'error' };

/** Invitation acceptance. A bad, used or expired token all show the same message (no existence leak). */
export function InvitationScreen({ token }: { token: string }) {
  const router = useRouter();
  const { ports, acceptInvitation } = useSession();
  const [preview, setPreview] = React.useState<Preview>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const [displayName, setDisplayName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [confirmation, setConfirmation] = React.useState('');
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [submitting, setSubmitting] = React.useState(false);
  const [rejected, setRejected] = React.useState<'fields' | 'unavailable' | false>(false);

  React.useEffect(() => {
    let cancelled = false;
    setPreview({ status: 'loading' });
    void ports.auth.inspectInvitation(token).then((result: Result<InvitationPreview>) => {
      if (cancelled) return;
      if (result.ok) setPreview({ status: 'ready', preview: result.value });
      else setPreview({ status: result.error.status === 404 ? 'unavailable' : 'error' });
    });
    return () => {
      cancelled = true;
    };
  }, [ports, token, attempt]);

  if (preview.status === 'loading') return <UiState kind="loading" />;
  if (preview.status === 'error')
    return (
      <UiState kind="error" actionLabel="Reintentar" onAction={() => setAttempt((n) => n + 1)} />
    );
  if (preview.status === 'unavailable')
    return (
      <Box sx={{ maxWidth: 440, mx: 'auto', p: 3 }}>
        <PageHeader title="Aceptar invitación" />
        <UiState
          kind="expired"
          title="Invitación no disponible"
          description="El enlace no es válido, ya se usó o expiró. Pide una nueva invitación a tu administrador."
          actionLabel="Ir a iniciar sesión"
          onAction={() => router.navigate('/iniciar-sesion', { replace: true })}
        />
      </Box>
    );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    const flag = (field: string, message: string) => {
      next[field] = message;
    };
    if (!displayName.trim()) flag('displayName', 'Escribe tu nombre.');
    if (password.length < minimumPasswordLength)
      flag('password', `Usa al menos ${minimumPasswordLength} caracteres.`);
    if (confirmation !== password) flag('confirmation', 'Las contraseñas no coinciden.');
    setErrors(next);
    setRejected(false);
    if (Object.keys(next).length > 0) return;
    setSubmitting(true);
    const result = await acceptInvitation(token, { displayName: displayName.trim(), password });
    setSubmitting(false);
    if (result.ok) {
      setPassword('');
      setConfirmation('');
      router.navigate('/', { replace: true });
    } else if (result.error.status === 404) setPreview({ status: 'unavailable' });
    else {
      const fields = fieldErrorMap(result.error);
      setErrors(fields);
      setRejected(Object.keys(fields).length > 0 ? 'fields' : 'unavailable');
    }
  };

  return (
    <Box sx={{ maxWidth: 440, mx: 'auto', p: 3 }}>
      <PageHeader
        title="Aceptar invitación"
        description={`Te invitaron a ${preview.preview.companyName} con el rol ${preview.preview.roleLabel}.`}
      />
      <form onSubmit={(event) => void submit(event)} noValidate aria-label="Aceptar invitación">
        <FormSection
          title="Crea tu acceso"
          description={`La contraseña debe tener al menos ${minimumPasswordLength} caracteres.`}
        >
          {rejected === 'fields' && (
            <UiState
              kind="error"
              title="No pudimos activar tu cuenta"
              description="Revisa los campos marcados e intenta nuevamente."
            />
          )}
          {rejected === 'unavailable' && (
            <UiState
              kind="error"
              title="Servicio no disponible"
              description="No pudimos activar tu cuenta por ahora. Intenta nuevamente."
            />
          )}
          <Field
            id="invitation-name"
            label="Nombre completo"
            autoComplete="name"
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            error={Boolean(errors.displayName)}
            helperText={errors.displayName}
          />
          <Field
            id="invitation-password"
            label="Contraseña"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={Boolean(errors.password)}
            helperText={errors.password}
          />
          <Field
            id="invitation-confirmation"
            label="Confirma la contraseña"
            type="password"
            autoComplete="new-password"
            required
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            error={Boolean(errors.confirmation)}
            helperText={errors.confirmation}
          />
          <Button type="submit" variant="contained" loading={submitting}>
            Activar cuenta
          </Button>
          <Typography variant="body2" color="text.secondary">
            Tu empresa y tu rol los define la invitación; no se pueden cambiar aquí.
          </Typography>
        </FormSection>
      </form>
    </Box>
  );
}
