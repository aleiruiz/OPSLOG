import React from 'react';
import { PageHeader } from '@opslog/ui';
import { ResourceView, useResource } from '../app/resource';
import { useRouter } from '../app/router';
import type { ApiError, Vehicle } from '../app/types';
import { useSession } from '../auth/session';
import { isEditable } from './labels';
import { VehicleForm, type FormAlert } from './VehicleForm';
import { VehicleNotEditable, VehicleNotFound } from './VehicleMessages';
import {
  changes,
  duplicateErrors,
  toInput,
  valuesOf,
  type FieldErrors,
  type VehicleFormValues,
} from './formModel';

interface Failure {
  readonly alert: FormAlert | null;
  readonly fields: FieldErrors;
}

const RELOAD = 'Cargar datos actuales';

/** Maps a failed save to what the person sees: a field message, an alert, or (401) nothing at all. */
export function describeFailure(error: ApiError, saved: boolean): Failure {
  // `saved`: the field changes went through and only the odometer reading failed.
  const savedNote = saved
    ? ' Los demás datos del vehículo sí se guardaron.'
    : ' Tus cambios no se guardaron.';
  const fail = (title: string, message: string, actionLabel?: string): FormAlert => ({
    severity: 'error',
    title,
    message,
    ...(actionLabel ? { actionLabel } : {}),
  });
  if (error.status === 401) return { alert: null, fields: {} };
  if (error.code === 'stale_version')
    return {
      alert: fail(
        'Otra persona modificó este vehículo',
        `Cambió mientras lo editabas.${savedNote} Carga los datos actuales y vuelve a hacer tus cambios.`,
        RELOAD,
      ),
      fields: {},
    };
  if (error.code === 'immutable')
    return {
      alert: fail(
        'El vehículo ya no admite cambios',
        `Se archivó o se dio de baja mientras lo editabas.${savedNote}`,
      ),
      fields: {},
    };
  if (error.code === 'duplicate')
    return {
      alert: fail(
        'Hay datos que ya existen',
        'Otro vehículo de tu empresa usa el mismo valor. Corrige los campos marcados.',
      ),
      fields: duplicateErrors(error),
    };
  if (error.code === 'invalid_area')
    return {
      alert: fail(
        'El área no es válida',
        'El área no existe o está inactiva. Elige un área activa de tu empresa.',
      ),
      fields: { areaId: 'El área no existe o está inactiva.' },
    };
  if (error.code === 'odometer_decrease')
    return {
      alert: fail(
        'Lectura de odómetro rechazada',
        `El servidor ya tiene una lectura mayor, quizá registrada por otra persona.${saved ? ' Los demás datos del vehículo sí se guardaron.' : ''} Carga los datos actuales para ver la última lectura.`,
        RELOAD,
      ),
      fields: { odometerKm: 'El odómetro no puede ser menor a la lectura que ya está registrada.' },
    };
  if (error.status === 400)
    return {
      alert: fail(
        'El servidor rechazó los datos',
        `Revisa todos los campos e intenta de nuevo.${savedNote}`,
      ),
      fields: {},
    };
  if (error.status === 403)
    return {
      alert: fail('No tienes permiso', 'Tu rol no permite guardar cambios en vehículos.'),
      fields: {},
    };
  if (error.status === 404)
    return { alert: fail('El vehículo ya no existe', 'No se guardó ningún cambio.'), fields: {} };
  return {
    alert: fail(
      'No pudimos guardar el vehículo',
      `Intenta nuevamente.${saved ? ' Los demás datos del vehículo sí se guardaron.' : ''}`,
    ),
    fields: {},
  };
}

/** Create form. Requires `create`. */
export function VehicleCreateScreen() {
  const { ports, markExpired } = useSession();
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState(false);
  const [failure, setFailure] = React.useState<Failure>({ alert: null, fields: {} });

  const submit = async (values: VehicleFormValues) => {
    setSubmitting(true);
    setFailure({ alert: null, fields: {} });
    const result = await ports.vehicles.create(toInput(values));
    setSubmitting(false);
    if (result.ok)
      router.navigate(`/flota/vehiculos/${encodeURIComponent(result.value.id)}?aviso=creado`);
    else {
      if (result.error.status === 401) markExpired();
      setFailure(describeFailure(result.error, false));
    }
  };

  return (
    <>
      <PageHeader
        title="Nuevo vehículo"
        description="El vehículo se crea con estado Activo y la fecha de alta que indiques."
      />
      <VehicleForm
        mode="create"
        submitting={submitting}
        serverErrors={failure.fields}
        alert={failure.alert}
        cancelTo="/flota/vehiculos"
        onSubmit={(values) => void submit(values)}
      />
    </>
  );
}

/** Unsaved edits that outlive a reload of the vehicle (an expired session reloads it after signing in). */
interface EditDraft {
  values: VehicleFormValues;
  baseVersion: number;
}

function EditForm({
  vehicle,
  setVehicle,
  reload,
  draft,
}: {
  vehicle: Vehicle;
  setVehicle: (vehicle: Vehicle) => void;
  reload: () => void;
  draft: React.MutableRefObject<EditDraft | null>;
}) {
  const { ports, markExpired } = useSession();
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState(false);
  // Edits are restored only if the vehicle is still at the version they were made on; otherwise they could
  // silently overwrite what another person saved in the meantime.
  const [start] = React.useState(() => {
    const kept = draft.current;
    if (kept && kept.baseVersion === vehicle.version)
      return { values: kept.values, outdated: false };
    draft.current = null;
    return { values: valuesOf(vehicle), outdated: kept !== null };
  });
  const [failure, setFailure] = React.useState<Failure>({
    alert: start.outdated
      ? {
          severity: 'warning',
          message:
            'El vehículo cambió desde que empezaste a editar. Cargamos los datos actuales: vuelve a hacer tus cambios.',
        }
      : null,
    fields: {},
  });
  const detail = `/flota/vehiculos/${encodeURIComponent(vehicle.id)}`;
  const version = vehicle.version;
  // Stable identity: the form reports edits only when they change, never on an unrelated re-render.
  const remember = React.useCallback(
    (values: VehicleFormValues) => {
      draft.current = { values, baseVersion: draft.current?.baseVersion ?? version };
    },
    [draft, version],
  );

  const submit = async (values: VehicleFormValues) => {
    const { patch, odometerKm } = changes(vehicle, values);
    if (!patch && odometerKm === null) {
      setFailure({
        alert: { severity: 'info', message: 'No hay cambios que guardar.' },
        fields: {},
      });
      return;
    }
    setSubmitting(true);
    setFailure({ alert: null, fields: {} });
    let current = vehicle;
    let saved = false;
    if (patch) {
      const result = await ports.vehicles.update(vehicle.id, {
        version: current.version,
        ...patch,
      });
      if (!result.ok) {
        setSubmitting(false);
        if (result.error.status === 401) markExpired();
        setFailure(describeFailure(result.error, false));
        return;
      }
      current = result.value;
      saved = true;
      if (draft.current) draft.current.baseVersion = current.version;
      setVehicle(current);
    }
    if (odometerKm !== null) {
      // The odometer has its own command and its own version check: it follows the field changes.
      const result = await ports.vehicles.recordOdometer(vehicle.id, {
        version: current.version,
        odometerKm,
      });
      if (!result.ok) {
        setSubmitting(false);
        if (result.error.status === 401) markExpired();
        setFailure(describeFailure(result.error, saved));
        return;
      }
    }
    setSubmitting(false);
    router.navigate(`${detail}?aviso=guardado`);
  };

  return (
    <VehicleForm
      mode="edit"
      initial={start.values}
      onValuesChange={remember}
      currentOdometerKm={vehicle.odometerKm}
      submitting={submitting}
      serverErrors={failure.fields}
      alert={failure.alert}
      onAlertAction={() => {
        draft.current = null;
        reload();
      }}
      cancelTo={detail}
      onSubmit={(values) => void submit(values)}
    />
  );
}

/** Edit form. Requires `edit`; archived and decommissioned vehicles are read-only. */
export function VehicleEditScreen({ id }: { id: string }) {
  const { ports } = useSession();
  const { state, reload, setData, generation } = useResource(
    () => ports.vehicles.get(id),
    [ports, id],
  );
  const draft = React.useRef<EditDraft | null>(null);
  return (
    <>
      <PageHeader
        title="Editar vehículo"
        description="Los cambios se guardan sobre la versión que cargaste; si otra persona cambia el vehículo antes, te avisaremos."
      />
      {state.status === 'error' && state.error.status === 404 ? (
        <VehicleNotFound />
      ) : (
        <ResourceView state={state} onRetry={reload}>
          {(vehicle) =>
            isEditable(vehicle) ? (
              <EditForm
                key={generation}
                vehicle={vehicle}
                setVehicle={setData}
                reload={reload}
                draft={draft}
              />
            ) : (
              <VehicleNotEditable vehicleId={vehicle.id} />
            )
          }
        </ResourceView>
      )}
    </>
  );
}
