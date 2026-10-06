import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, FormSection, PageHeader, UiState } from '@opslog/ui';
import type { InvitationPreview, Result } from '../app/types';
import { useRouter } from '../app/router';
import { OidcHintField, useHintMissing } from './OidcHintField';
import { useSession } from './session';

type Preview =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly preview: InvitationPreview }
  | { readonly status: 'unavailable' }
  | { readonly status: 'error' };

/** Invitation acceptance. A bad, used or expired token all show the same message (no existence leak). */
export function InvitationScreen({
  token,
  onConsumed,
}: {
  token: string;
  /** The token is spent (accepted) or known to be unusable: the caller must forget it. */
  onConsumed?: () => void;
}) {
  const router = useRouter();
  const { ports, acceptInvitation } = useSession();
  const [preview, setPreview] = React.useState<Preview>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const [hint, setHint] = React.useState('');
  const missing = useHintMissing(hint);
  const [submitting, setSubmitting] = React.useState(false);
  const [problem, setProblem] = React.useState<'incomplete' | 'rejected' | 'unavailable' | null>(
    null,
  );

  React.useEffect(() => {
    let cancelled = false;
    setPreview({ status: 'loading' });
    void ports.auth.inspectInvitation(token).then((result: Result<InvitationPreview>) => {
      if (cancelled) return;
      if (result.ok) setPreview({ status: 'ready', preview: result.value });
      else if (result.error.status === 404) {
        onConsumed?.();
        setPreview({ status: 'unavailable' });
      } else setPreview({ status: 'error' });
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
    if (missing) {
      setProblem('incomplete');
      return;
    }
    setProblem(null);
    setSubmitting(true);
    const result = await acceptInvitation(token, hint);
    setSubmitting(false);
    if (result.ok) {
      onConsumed?.();
      router.navigate('/', { replace: true });
    } else if (result.error.status === 404) {
      onConsumed?.();
      setPreview({ status: 'unavailable' });
    } else setProblem(result.error.status === 401 ? 'rejected' : 'unavailable');
  };

  return (
    <Box sx={{ maxWidth: 440, mx: 'auto', p: 3 }}>
      <PageHeader
        title="Aceptar invitación"
        description={`Te invitaron a ${preview.preview.companyName} con el rol ${preview.preview.roleLabel}.`}
      />
      <form onSubmit={(event) => void submit(event)} noValidate aria-label="Aceptar invitación">
        <FormSection
          title="Confirma tu identidad"
          description="Tu cuenta de identidad queda vinculada a esta invitación."
        >
          {problem === 'incomplete' && (
            <UiState kind="incomplete" description="Indica la cuenta de prueba para continuar." />
          )}
          {problem === 'rejected' && (
            <UiState
              kind="error"
              title="No pudimos activar tu cuenta"
              description="No pudimos verificar tu identidad. Intenta nuevamente."
            />
          )}
          {problem === 'unavailable' && (
            <UiState
              kind="error"
              title="Servicio no disponible"
              description="No pudimos activar tu cuenta por ahora. Intenta nuevamente."
            />
          )}
          <OidcHintField id="invitation-account" value={hint} onChange={setHint} />
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
