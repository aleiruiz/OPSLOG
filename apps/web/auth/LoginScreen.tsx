import Box from '@mui/material/Box';
import React from 'react';
import { Button, FormSection, PageHeader, UiState } from '@opslog/ui';
import { useRouter } from '../app/router';
import { safeNextPath } from '../app/routes';
import { OidcHintField, useHintMissing } from './OidcHintField';
import { useSession } from './session';

/** The identity provider authorizes the sign-in; the BFF verifies the code and answers with an httpOnly cookie. */
export function LoginScreen() {
  const router = useRouter();
  const { signIn } = useSession();
  const [hint, setHint] = React.useState('');
  const missing = useHintMissing(hint);
  const [submitting, setSubmitting] = React.useState(false);
  const [problem, setProblem] = React.useState<'incomplete' | 'rejected' | 'unavailable' | null>(
    null,
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (missing) {
      setProblem('incomplete');
      return;
    }
    setSubmitting(true);
    setProblem(null);
    const result = await signIn(hint);
    setSubmitting(false);
    if (result.ok) {
      router.navigate(safeNextPath(router.search.get('siguiente')), { replace: true });
    } else setProblem(result.error.status === 401 ? 'rejected' : 'unavailable');
  };

  return (
    <Box sx={{ maxWidth: 440, mx: 'auto', p: 3 }}>
      <PageHeader title="Iniciar sesión" description="Entra con tu cuenta de identidad." />
      <form onSubmit={(event) => void submit(event)} noValidate aria-label="Inicio de sesión">
        <FormSection title="Tu identidad">
          {problem === 'incomplete' && (
            <UiState kind="incomplete" description="Indica la cuenta de prueba para continuar." />
          )}
          {problem === 'rejected' && (
            <UiState
              kind="error"
              title="No pudimos iniciar sesión"
              description="No pudimos verificar tu identidad."
            />
          )}
          {problem === 'unavailable' && (
            <UiState
              kind="error"
              title="Servicio no disponible"
              description="No pudimos iniciar sesión por ahora. Intenta nuevamente."
            />
          )}
          <OidcHintField id="login-account" value={hint} onChange={setHint} />
          <Button type="submit" variant="contained" loading={submitting}>
            Iniciar sesión
          </Button>
        </FormSection>
      </form>
    </Box>
  );
}
