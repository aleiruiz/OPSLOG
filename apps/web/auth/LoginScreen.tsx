import Box from '@mui/material/Box';
import React from 'react';
import { Button, Field, FormSection, PageHeader, UiState } from '@opslog/ui';
import { useRouter } from '../app/router';
import { safeNextPath } from '../app/routes';
import { useSession } from './session';

/** Credentials go to the BFF, which answers with an httpOnly cookie; the password is never kept. */
export function LoginScreen() {
  const router = useRouter();
  const { login } = useSession();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [problem, setProblem] = React.useState<'incomplete' | 'rejected' | 'unavailable' | null>(
    null,
  );

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !password) {
      setProblem('incomplete');
      return;
    }
    setSubmitting(true);
    setProblem(null);
    const result = await login({ email, password });
    setSubmitting(false);
    if (result.ok) {
      setPassword('');
      router.navigate(safeNextPath(router.search.get('siguiente')), { replace: true });
    } else setProblem(result.error.status === 401 ? 'rejected' : 'unavailable');
  };

  return (
    <Box sx={{ maxWidth: 440, mx: 'auto', p: 3 }}>
      <PageHeader title="Iniciar sesión" description="Entra con tu cuenta de OPSLOG." />
      <form onSubmit={(event) => void submit(event)} noValidate aria-label="Inicio de sesión">
        <FormSection title="Tus credenciales">
          {problem === 'incomplete' && (
            <UiState
              kind="incomplete"
              description="Escribe tu correo y tu contraseña para continuar."
            />
          )}
          {problem === 'rejected' && (
            <UiState
              kind="error"
              title="No pudimos iniciar sesión"
              description="El correo o la contraseña no son correctos."
            />
          )}
          {problem === 'unavailable' && (
            <UiState
              kind="error"
              title="Servicio no disponible"
              description="No pudimos iniciar sesión por ahora. Intenta nuevamente."
            />
          )}
          <Field
            id="login-email"
            label="Correo electrónico"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Field
            id="login-password"
            label="Contraseña"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button type="submit" variant="contained" loading={submitting}>
            Iniciar sesión
          </Button>
        </FormSection>
      </form>
    </Box>
  );
}
