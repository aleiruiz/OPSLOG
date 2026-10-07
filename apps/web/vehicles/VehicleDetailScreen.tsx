import React from 'react';
import { useResource } from '../app/resource';
import { useRouter } from '../app/router';
import type { ApiError } from '../app/types';
import { useSession } from '../auth/session';
import { AssignmentHistorySection } from '../assignments/AssignmentHistorySection';
import { archiveClosed, VehicleDetailView, type ArchiveDialogState } from './VehicleDetailView';

const notices: Record<string, string> = {
  creado: 'Vehículo creado.',
  guardado: 'Cambios guardados.',
};

function archiveFailure(error: ApiError): Pick<ArchiveDialogState, 'error' | 'errorActionLabel'> {
  if (error.code === 'stale_version')
    return {
      error:
        'Otra persona modificó este vehículo mientras lo revisabas. Recarga los datos y vuelve a decidir.',
      errorActionLabel: 'Recargar datos',
    };
  if (error.code === 'immutable')
    return { error: 'Este vehículo ya estaba archivado.', errorActionLabel: 'Recargar datos' };
  if (error.status === 403) return { error: 'No tienes permiso para archivar vehículos.' };
  if (error.status === 404) return { error: 'Este vehículo ya no existe.' };
  return { error: 'No pudimos archivar el vehículo. Intenta nuevamente.' };
}

/** Vehicle detail screen. Requires `view`; "Editar" needs `edit` and "Archivar" needs `delete`. */
export function VehicleDetailScreen({ id }: { id: string }) {
  const { ports, can, markExpired } = useSession();
  const router = useRouter();
  const { state, reload, setData } = useResource(() => ports.vehicles.get(id), [ports, id]);
  const [notice, setNotice] = React.useState<string | null>(() => {
    const code = router.search.get('aviso') ?? '';
    return Object.hasOwn(notices, code) ? (notices[code] ?? null) : null;
  });
  const [archive, setArchive] = React.useState<ArchiveDialogState>(archiveClosed);

  // The result of the previous screen is shown once and removed from the address bar.
  React.useEffect(() => {
    if (router.search.has('aviso'))
      router.navigate(`/flota/vehiculos/${encodeURIComponent(id)}`, { replace: true });
  }, [router, id]);

  const confirm = async () => {
    if (state.status !== 'ready') return;
    setArchive({ open: true, busy: true });
    const result = await ports.vehicles.archive(id, state.data.version);
    if (result.ok) {
      setData(result.value);
      setArchive(archiveClosed);
      setNotice('Vehículo archivado.');
    } else if (result.error.status === 401) {
      // The dialog lives outside the inert screen: close it so it cannot sit over the sign-in panel.
      setArchive(archiveClosed);
      markExpired();
    } else setArchive({ open: true, busy: false, ...archiveFailure(result.error) });
  };

  return (
    <>
      <VehicleDetailView
        state={state}
        can={can}
        notice={notice}
        archive={archive}
        onRetry={reload}
        onArchiveRequest={() => setArchive({ open: true, busy: false })}
        onArchiveConfirm={() => void confirm()}
        onArchiveCancel={() => setArchive(archiveClosed)}
        onArchiveErrorAction={() => {
          setArchive(archiveClosed);
          reload();
        }}
      />
      {state.status === 'ready' && <AssignmentHistorySection vehicleId={state.data.id} />}
    </>
  );
}
