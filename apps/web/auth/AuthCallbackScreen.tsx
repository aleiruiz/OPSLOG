import React from 'react';
import { PageHeader, UiState } from '@opslog/ui';
import { useRouter } from '../app/router';
import { safeNextPath } from '../app/routes';
import { AuthLayout } from './AuthLayout';
import { useSession } from './session';

/** Return address of a redirecting identity provider: redeems its answer once, then moves on. */
export function AuthCallbackScreen() {
  const router = useRouter();
  const { completeSignIn } = useSession();
  const [failed, setFailed] = React.useState(false);
  // The authorization code is single use: React's development double-run must not redeem it twice.
  const started = React.useRef(false);
  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    void completeSignIn(router.search)
      .then((result) => {
        if (result.ok) router.navigate(safeNextPath(result.value.next ?? null), { replace: true });
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [completeSignIn, router]);

  return (
    <AuthLayout>
      <PageHeader title="Verificando acceso" />
      {failed ? (
        <UiState
          kind="error"
          title="No pudimos iniciar sesión"
          description="No pudimos verificar tu identidad. Intenta nuevamente."
          actionLabel="Ir a iniciar sesión"
          onAction={() => router.navigate('/iniciar-sesion', { replace: true })}
        />
      ) : (
        <UiState kind="loading" />
      )}
    </AuthLayout>
  );
}
