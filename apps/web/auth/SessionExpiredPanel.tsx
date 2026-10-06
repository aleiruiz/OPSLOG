import Box from '@mui/material/Box';
import React from 'react';
import { Button, Field, FormSection, UiState } from '@opslog/ui';
import { useSession } from './session';

/**
 * Shown over the current screen when the session expires. The screen below stays mounted (but inert) so
 * its drafts are not lost; signing in again as the same person resumes them.
 */
export function SessionExpiredPanel({ email }: { email: string }) {
  const { login } = useSession();
  const [password, setPassword] = React.useState('');
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
    const result = await login({ email, password });
    setSubmitting(false);
    if (result.ok) setPassword('');
    else setFailed(true);
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
              description="La contraseña no es correcta o el servicio no está disponible."
            />
          )}
          <Field id="reauth-email" label="Correo electrónico" value={email} disabled />
          <Field
            id="reauth-password"
            label="Contraseña"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button type="submit" variant="contained" loading={submitting} disabled={!password}>
            Continuar
          </Button>
        </FormSection>
      </form>
    </Box>
  );
}
