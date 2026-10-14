import React from 'react';
import { PageHeader, UiState } from '@opslog/ui';
import { useRouter } from '../app/router';
import { safeNextPath } from '../app/routes';
import { AuthLayout } from './AuthLayout';
import { useSession } from './session';

// Covers both "not a member of any company" and "invitation not accepted" without saying which.
const NO_ACCOUNT =
  'No encontramos una cuenta activa de OPSLOG para este usuario. Si te invitaron, abre el enlace de la invitación; si no, pide acceso al administrador de tu empresa.';

/** The single-use authorization code must not linger in the address bar or the history entry. */
function clearAuthorizationCode(): void {
  try {
    window.history.replaceState(window.history.state, '', window.location.pathname);
  } catch {
    // Not fatal: the code is already spent.
  }
}

/** Return address of a redirecting identity provider: redeems its answer once, then moves on. */
export function AuthCallbackScreen() {
  const router = useRouter();
  const { completeSignIn } = useSession();
  const [failed, setFailed] = React.useState<false | 'identity' | 'access'>(false);
  // The authorization code is single use: React's development double-run must not redeem it twice.
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void completeSignIn(router.search)
      .then((result) => {
        clearAuthorizationCode();
        if (result.ok) router.navigate(safeNextPath(result.value.next ?? null), { replace: true });
        else
          setFailed(
            result.error.status === 401 && result.error.correlationId !== 'oidc-redirect'
              ? 'access'
              : 'identity',
          );
      })
      .catch(() => {
        clearAuthorizationCode();
        setFailed('identity');
      });
  }, [completeSignIn, router]);

  return (
    <AuthLayout>
      <PageHeader title="Verificando acceso" />
      {failed ? (
        <UiState
          kind="error"
          title="No pudimos iniciar sesión"
          description={
            failed === 'access'
              ? NO_ACCOUNT
              : 'No pudimos verificar tu identidad. Intenta nuevamente.'
          }
          actionLabel="Ir a iniciar sesión"
          onAction={() => router.navigate('/iniciar-sesion', { replace: true })}
        />
      ) : (
        <UiState kind="loading" />
      )}
    </AuthLayout>
  );
}
