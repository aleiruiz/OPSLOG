import Box from '@mui/material/Box';
import React from 'react';
import { Button, FormSection, UiState } from '@opslog/ui';
import { OidcHintField, useHintMissing } from './OidcHintField';
import { useSession } from './session';

/**
 * Shown over the current screen when the session expires. The screen below stays mounted (but inert) so
 * its drafts are not lost; signing in again as the same person resumes them.
 */
export function SessionExpiredPanel() {
  const { signIn } = useSession();
  const [hint, setHint] = React.useState('');
  const missing = useHintMissing(hint);
  const [submitting, setSubmitting] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const heading = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    heading.current?.focus();
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setFailed(false);
    const result = await signIn(hint);
    setSubmitting(false);
    if (!result.ok) setFailed(true);
  };

  return (
    <Box
      role="group"
      aria-label="Sesión expirada"
      sx={{ mb: 3, maxWidth: 560 }}
      ref={heading}
      tabIndex={-1}
    >
      <UiState
        kind="session-expired"
        description="Tus borradores guardados siguen en el servidor. Los cambios más recientes se mantienen en esta pantalla y se guardarán al volver a iniciar sesión."
      />
      <form onSubmit={(event) => void submit(event)} noValidate aria-label="Reautenticación">
        <FormSection title="Vuelve a iniciar sesión">
          {failed && (
            <UiState
              kind="error"
              title="No pudimos iniciar sesión"
              description="No pudimos verificar tu identidad o el servicio no está disponible."
            />
          )}
          <OidcHintField id="reauth-account" value={hint} onChange={setHint} />
          <Button type="submit" variant="contained" loading={submitting} disabled={missing}>
            Continuar
          </Button>
        </FormSection>
      </form>
    </Box>
  );
}
