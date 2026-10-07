import React from 'react';
import { PageHeader } from '@opslog/ui';
import { loadDriverOptions } from '../app/driverOptions';
import { ResourceView, useResource } from '../app/resource';
import { useRouter } from '../app/router';
import type { ApiError, VehicleAssignment } from '../app/types';
import { useVehicleName } from '../app/useVehicleName';
import { loadVehicleOptions } from '../app/vehicleOptions';
import { useSession } from '../auth/session';
import { AssignmentForm, REPLACE_ACTION, type FormAlert } from './AssignmentForm';
import {
  AssignmentNotEndable,
  AssignmentNotFound,
  assignmentPath,
  assignmentsPath,
} from './AssignmentMessages';
import {
  namesField,
  pickerErrors,
  toEnd,
  toInput,
  type AssignFieldErrors,
  type AssignFormValues,
  type EndFieldErrors,
  type FormMode,
} from './formModel';
import { isCurrent } from './labels';

interface Failure {
  readonly alert: FormAlert | null;
  readonly fields: AssignFieldErrors & EndFieldErrors;
}

const RELOAD = 'Cargar datos actuales';
const none: Failure = { alert: null, fields: {} };

/**
 * Maps a failed save to what the person sees: a field message, an alert, or (401) nothing at all. The conflicts of the
 * business rules say which rule: BR-002 (one current principal per vehicle), BR-003 (one principal vehicle per driver)
 * and BR-014 (only an eligible vehicle and driver). The server never says why a 422 happened, so neither does the
 * message.
 */
export function describeFailure(error: ApiError, mode: FormMode, canReplace = false): Failure {
  const verb = mode === 'end' ? 'cerrar' : 'crear';
  const fail = (title: string, message: string, actionLabel?: string): FormAlert => ({
    severity: 'error',
    title,
    message,
    ...(actionLabel ? { actionLabel } : {}),
  });
  if (error.status === 401) return none;
  if (error.code === 'stale_version')
    return {
      alert: fail(
        'Otra persona modificó esta asignación',
        'Cambió mientras la trabajabas. No se cerró. Carga los datos actuales y decide de nuevo.',
        RELOAD,
      ),
      fields: {},
    };
  if (error.code === 'immutable')
    return {
      alert: fail(
        'La asignación ya estaba cerrada',
        'Otra persona la cerró mientras la trabajabas. No se hizo ningún cambio.',
      ),
      fields: {},
    };
  if (error.code === 'principal_taken' && namesField(error, 'vehicle_id'))
    return {
      alert: fail(
        'El vehículo ya tiene un conductor principal',
        canReplace
          ? 'Un vehículo tiene a lo sumo un principal vigente (BR-002). Puedes reemplazarlo: su asignación se cierra y queda en el historial.'
          : 'Un vehículo tiene a lo sumo un principal vigente (BR-002). Cierra su asignación actual, o pide a alguien con permiso para editar que lo reemplace. También puedes asignar al conductor como secundario o temporal.',
        canReplace ? REPLACE_ACTION : undefined,
      ),
      fields: {},
    };
  if (error.code === 'principal_taken' && namesField(error, 'employee_id'))
    return {
      alert: fail(
        'El conductor ya es principal de otro vehículo',
        'Un conductor es principal de a lo sumo un vehículo (BR-003). Cierra su otra asignación principal o asígnalo como secundario o temporal. Reemplazar no cambia esta regla.',
      ),
      fields: pickerErrors(error),
    };
  if (error.code === 'already_assigned')
    return {
      alert: fail(
        'El conductor ya está asignado a este vehículo',
        'Ya existe una asignación vigente de este conductor a este vehículo. Ciérrala antes de crear otra.',
      ),
      fields: pickerErrors(error),
    };
  if (error.code === 'invalid_vehicle' || error.code === 'invalid_employee')
    return {
      alert: fail(
        error.code === 'invalid_vehicle'
          ? 'El vehículo no se puede asignar'
          : 'El conductor no se puede asignar',
        'Solo se asignan vehículos que no están archivados, inactivos ni dados de baja, y conductores activos y no archivados (BR-014).',
      ),
      fields: pickerErrors(error),
    };
  if (error.status === 400)
    return {
      alert: fail(
        'El servidor rechazó los datos',
        'Revisa todos los campos e intenta de nuevo. No se guardó ningún cambio.',
      ),
      fields: {},
    };
  if (error.status === 403)
    return {
      alert: fail(
        'No tienes permiso',
        mode === 'end'
          ? 'Tu rol no permite cerrar asignaciones.'
          : 'Tu rol no permite crear esta asignación. Reemplazar al principal requiere permiso para crear y para editar.',
      ),
      fields: {},
    };
  if (error.status === 404)
    return { alert: fail('La asignación ya no existe', 'No se hizo ningún cambio.'), fields: {} };
  return { alert: fail(`No pudimos ${verb} la asignación`, 'Intenta nuevamente.'), fields: {} };
}

/** Create form. Requires `create`; replacing the principal also needs `edit`. */
export function AssignmentCreateScreen() {
  const { ports, can, markExpired } = useSession();
  const router = useRouter();
  const vehicles = useResource(() => loadVehicleOptions(ports.vehicles), [ports]);
  const drivers = useResource(() => loadDriverOptions(ports.employees), [ports]);
  const [submitting, setSubmitting] = React.useState(false);
  const [failure, setFailure] = React.useState<Failure>(none);
  const canReplace = can('edit');
  // A vehicle or a driver chosen on the previous screen (`?vehiculo=`, `?conductor=`).
  const [initial] = React.useState(() => ({
    vehicleId: router.search.get('vehiculo') ?? '',
    employeeId: router.search.get('conductor') ?? '',
  }));

  const submit = async (values: AssignFormValues) => {
    setSubmitting(true);
    setFailure(none);
    const result = await ports.assignments.assign(
      toInput({ ...values, replace: values.replace && canReplace }),
    );
    setSubmitting(false);
    if (result.ok)
      router.navigate(
        `${assignmentPath(result.value.assignment.id)}?aviso=${result.value.replaced ? 'reemplazada' : 'creada'}`,
      );
    else {
      if (result.error.status === 401) markExpired();
      setFailure(describeFailure(result.error, 'assign', canReplace));
    }
  };

  return (
    <>
      <PageHeader
        title="Nueva asignación"
        description="Asigna un conductor a un vehículo. El inicio es el momento de la asignación y no se puede cambiar; para terminarla, ciérrala."
      />
      <ResourceView state={vehicles.state} onRetry={vehicles.reload}>
        {(vehicleOptions) => (
          <ResourceView state={drivers.state} onRetry={drivers.reload}>
            {(driverOptions) => (
              <AssignmentForm
                mode="assign"
                initial={initial}
                vehicles={vehicleOptions}
                drivers={driverOptions}
                canReplace={canReplace}
                submitting={submitting}
                serverErrors={failure.fields}
                alert={failure.alert}
                cancelTo={assignmentsPath}
                onSubmit={(values) => void submit(values)}
              />
            )}
          </ResourceView>
        )}
      </ResourceView>
    </>
  );
}

/** Unsaved reason that outlives a reload of the assignment (an expired session reloads it after signing in). */
interface Draft {
  reason: string;
  baseVersion: number;
}

function EndForm({
  assignment,
  setAssignment,
  reload,
  draft,
}: {
  assignment: VehicleAssignment;
  setAssignment: (assignment: VehicleAssignment) => void;
  reload: () => void;
  draft: React.MutableRefObject<Draft | null>;
}) {
  const { ports, markExpired } = useSession();
  const router = useRouter();
  const vehicleName = useVehicleName(assignment.vehicleId);
  const drivers = useResource(() => loadDriverOptions(ports.employees), [ports]);
  const driverName =
    drivers.state.status === 'ready'
      ? drivers.state.data.items.find((item) => item.id === assignment.employeeId)?.name
      : undefined;
  const [submitting, setSubmitting] = React.useState(false);
  // The reason is restored only if the assignment is still at the version it was written on.
  const [start] = React.useState(() => {
    const kept = draft.current;
    if (kept && kept.baseVersion === assignment.version)
      return { reason: kept.reason, outdated: false };
    draft.current = null;
    return { reason: '', outdated: kept !== null };
  });
  const [failure, setFailure] = React.useState<Failure>({
    alert: start.outdated
      ? {
          severity: 'warning',
          message:
            'La asignación cambió desde que empezaste. Cargamos los datos actuales: escribe el motivo de nuevo.',
        }
      : null,
    fields: {},
  });
  const version = assignment.version;
  const remember = React.useCallback(
    (values: AssignFormValues) => {
      draft.current = { reason: values.reason, baseVersion: draft.current?.baseVersion ?? version };
    },
    [draft, version],
  );

  const submit = async (values: AssignFormValues) => {
    setSubmitting(true);
    setFailure(none);
    const result = await ports.assignments.end(assignment.id, {
      version,
      ...toEnd({ reason: values.reason }),
    });
    setSubmitting(false);
    if (result.ok) {
      setAssignment(result.value);
      router.navigate(`${assignmentPath(assignment.id)}?aviso=cerrada`);
    } else {
      if (result.error.status === 401) markExpired();
      setFailure(describeFailure(result.error, 'end'));
    }
  };

  return (
    <AssignmentForm
      mode="end"
      initial={{ reason: start.reason }}
      assignment={assignment}
      {...(vehicleName ? { vehicleName } : {})}
      {...(driverName ? { driverName } : {})}
      onValuesChange={remember}
      submitting={submitting}
      serverErrors={failure.fields}
      alert={failure.alert}
      onAlertAction={() => {
        draft.current = null;
        reload();
      }}
      cancelTo={assignmentPath(assignment.id)}
      onSubmit={(values) => void submit(values)}
    />
  );
}

/** Close form. Requires `edit`; a closed assignment is read-only. */
export function AssignmentEndScreen({ id }: { id: string }) {
  const { ports } = useSession();
  const { state, reload, setData, generation } = useResource(
    () => ports.assignments.get(id),
    [ports, id],
  );
  const draft = React.useRef<Draft | null>(null);
  return (
    <>
      <PageHeader
        title="Cerrar asignación"
        description="Termina la asignación con un motivo. Queda en el historial y ya no se puede cambiar."
      />
      {state.status === 'error' && state.error.status === 404 ? (
        <AssignmentNotFound />
      ) : (
        <ResourceView state={state} onRetry={reload}>
          {(assignment) =>
            isCurrent(assignment) ? (
              <EndForm
                key={generation}
                assignment={assignment}
                setAssignment={setData}
                reload={reload}
                draft={draft}
              />
            ) : (
              <AssignmentNotEndable assignmentId={assignment.id} />
            )
          }
        </ResourceView>
      )}
    </>
  );
}
