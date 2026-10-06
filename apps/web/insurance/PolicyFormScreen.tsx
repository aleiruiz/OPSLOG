import React from 'react';
import { PageHeader } from '@opslog/ui';
import { ResourceView, useResource } from '../app/resource';
import { useRouter } from '../app/router';
import type { ApiError, InsurancePolicy } from '../app/types';
import { useVehicleName } from '../app/useVehicleName';
import { loadVehicleOptions } from '../app/vehicleOptions';
import { useSession } from '../auth/session';
import {
  changes,
  editValuesOf,
  renewalValuesOf,
  toInput,
  toRenewal,
  vehicleErrors,
  type FieldErrors,
  type FormMode,
  type PolicyFormValues,
} from './formModel';
import { isEditable } from './labels';
import { PolicyForm, type FormAlert } from './PolicyForm';
import { PolicyNotEditable, PolicyNotFound, policiesPath, policyPath } from './PolicyMessages';

interface Failure {
  readonly alert: FormAlert | null;
  readonly fields: FieldErrors;
}

const RELOAD = 'Cargar datos actuales';
const none: Failure = { alert: null, fields: {} };

/** Maps a failed save to what the person sees: a field message, an alert, or (401) nothing at all. */
export function describeFailure(error: ApiError, mode: FormMode): Failure {
  const verb = mode === 'renew' ? 'renovar' : 'guardar';
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
        'Otra persona modificó esta póliza',
        'Cambió mientras la trabajabas. Tus cambios no se guardaron. Carga los datos actuales y vuelve a hacer tus cambios.',
        RELOAD,
      ),
      fields: {},
    };
  if (error.code === 'immutable')
    return {
      alert: fail(
        'La póliza ya no admite cambios',
        'Se archivó mientras la trabajabas. Tus cambios no se guardaron.',
      ),
      fields: {},
    };
  if (error.code === 'invalid_vehicle')
    return {
      alert: fail(
        'El vehículo no es válido',
        mode === 'create'
          ? 'El vehículo no existe o está archivado. Elige otro vehículo de la lista.'
          : 'El vehículo de esta póliza ya no existe o está archivado, por lo que no se puede renovar.',
      ),
      fields: mode === 'create' ? vehicleErrors(error) : {},
    };
  if (error.status === 400)
    return {
      alert: fail(
        'El servidor rechazó los datos',
        'Revisa todos los campos e intenta de nuevo. Tus cambios no se guardaron.',
      ),
      fields: {},
    };
  if (error.status === 403)
    return {
      alert: fail(
        'No tienes permiso',
        `Tu rol no permite ${verb} esta póliza. Escribir el deducible requiere permiso para ver costos.`,
      ),
      fields: {},
    };
  if (error.status === 404)
    return { alert: fail('La póliza ya no existe', 'No se guardó ningún cambio.'), fields: {} };
  return { alert: fail(`No pudimos ${verb} la póliza`, 'Intenta nuevamente.'), fields: {} };
}

/** Create form. Requires `create`; the deductible also needs `view_costs`. */
export function PolicyCreateScreen() {
  const { ports, can, markExpired } = useSession();
  const router = useRouter();
  const vehicles = useResource(() => loadVehicleOptions(ports.vehicles), [ports]);
  const [submitting, setSubmitting] = React.useState(false);
  const [failure, setFailure] = React.useState<Failure>(none);
  const canViewCosts = can('view_costs');

  const submit = async (values: PolicyFormValues) => {
    setSubmitting(true);
    setFailure(none);
    const result = await ports.insurance.create(toInput(values, canViewCosts));
    setSubmitting(false);
    if (result.ok) router.navigate(`${policyPath(result.value.id)}?aviso=creada`);
    else {
      if (result.error.status === 401) markExpired();
      setFailure(describeFailure(result.error, 'create'));
    }
  };

  return (
    <>
      <PageHeader
        title="Nueva póliza"
        description="Registra la póliza de seguro de un vehículo y su vigencia. Los archivos adjuntos llegarán más adelante."
      />
      <ResourceView state={vehicles.state} onRetry={vehicles.reload}>
        {(options) => (
          <PolicyForm
            mode="create"
            canViewCosts={canViewCosts}
            vehicles={options}
            submitting={submitting}
            serverErrors={failure.fields}
            alert={failure.alert}
            cancelTo={policiesPath}
            onSubmit={(values) => void submit(values)}
          />
        )}
      </ResourceView>
    </>
  );
}

/** Unsaved edits that outlive a reload of the policy (an expired session reloads it after signing in). */
interface Draft {
  values: PolicyFormValues;
  baseVersion: number;
}

function ChangeForm({
  mode,
  policy,
  setPolicy,
  reload,
  draft,
}: {
  mode: 'edit' | 'renew';
  policy: InsurancePolicy;
  setPolicy: (policy: InsurancePolicy) => void;
  reload: () => void;
  draft: React.MutableRefObject<Draft | null>;
}) {
  const { ports, can, markExpired } = useSession();
  const router = useRouter();
  const canViewCosts = can('view_costs');
  const vehicleName = useVehicleName(policy.vehicleId);
  const [submitting, setSubmitting] = React.useState(false);
  // Edits are restored only if the policy is still at the version they were made on; otherwise they could
  // silently overwrite what another person saved in the meantime.
  const [start] = React.useState(() => {
    const kept = draft.current;
    if (kept && kept.baseVersion === policy.version)
      return { values: kept.values, outdated: false };
    draft.current = null;
    return {
      values: mode === 'edit' ? editValuesOf(policy) : renewalValuesOf(policy),
      outdated: kept !== null,
    };
  });
  const [failure, setFailure] = React.useState<Failure>({
    alert: start.outdated
      ? {
          severity: 'warning',
          message:
            'La póliza cambió desde que empezaste. Cargamos los datos actuales: vuelve a hacer tus cambios.',
        }
      : null,
    fields: {},
  });
  const version = policy.version;
  // Stable identity: the form reports edits only when they change, never on an unrelated re-render.
  const remember = React.useCallback(
    (values: PolicyFormValues) => {
      draft.current = { values, baseVersion: draft.current?.baseVersion ?? version };
    },
    [draft, version],
  );

  const submit = async (values: PolicyFormValues) => {
    if (mode === 'edit') {
      const patch = changes(policy, values);
      if (!patch) {
        setFailure({
          alert: { severity: 'info', message: 'No hay cambios que guardar.' },
          fields: {},
        });
        return;
      }
      setSubmitting(true);
      setFailure(none);
      const result = await ports.insurance.update(policy.id, { version, ...patch });
      setSubmitting(false);
      if (result.ok) {
        setPolicy(result.value);
        router.navigate(`${policyPath(policy.id)}?aviso=guardada`);
      } else {
        if (result.error.status === 401) markExpired();
        setFailure(describeFailure(result.error, 'edit'));
      }
      return;
    }
    setSubmitting(true);
    setFailure(none);
    const result = await ports.insurance.renew(policy.id, {
      version,
      ...toRenewal(values, canViewCosts),
    });
    setSubmitting(false);
    if (result.ok) {
      setPolicy(result.value);
      router.navigate(`${policyPath(policy.id)}?aviso=renovada`);
    } else {
      if (result.error.status === 401) markExpired();
      setFailure(describeFailure(result.error, 'renew'));
    }
  };

  return (
    <PolicyForm
      mode={mode}
      initial={start.values}
      canViewCosts={canViewCosts}
      policy={policy}
      {...(vehicleName ? { vehicleName } : {})}
      onValuesChange={remember}
      submitting={submitting}
      serverErrors={failure.fields}
      alert={failure.alert}
      onAlertAction={() => {
        draft.current = null;
        reload();
      }}
      cancelTo={policyPath(policy.id)}
      onSubmit={(values) => void submit(values)}
    />
  );
}

function ChangeScreen({ id, mode }: { id: string; mode: 'edit' | 'renew' }) {
  const { ports } = useSession();
  const { state, reload, setData, generation } = useResource(
    () => ports.insurance.get(id),
    [ports, id],
  );
  const draft = React.useRef<Draft | null>(null);
  return (
    <>
      <PageHeader
        title={mode === 'edit' ? 'Editar póliza' : 'Renovar póliza'}
        description={
          mode === 'edit'
            ? 'Aquí cambias la aseguradora y las notas. Para cambiar el periodo, el número, la cobertura o el deducible, renueva la póliza.'
            : 'Registra la nueva vigencia. Si otra persona cambia la póliza antes, te avisaremos.'
        }
      />
      {state.status === 'error' && state.error.status === 404 ? (
        <PolicyNotFound />
      ) : (
        <ResourceView state={state} onRetry={reload}>
          {(policy) =>
            isEditable(policy) ? (
              <ChangeForm
                key={generation}
                mode={mode}
                policy={policy}
                setPolicy={setData}
                reload={reload}
                draft={draft}
              />
            ) : (
              <PolicyNotEditable policyId={policy.id} />
            )
          }
        </ResourceView>
      )}
    </>
  );
}

/** Edit form (insurer and notes). Requires `edit`; archived policies are read-only. */
export const PolicyEditScreen = ({ id }: { id: string }) => <ChangeScreen id={id} mode="edit" />;

/** Renewal form (a new revision). Requires `edit`; archived policies are read-only. */
export const PolicyRenewScreen = ({ id }: { id: string }) => <ChangeScreen id={id} mode="renew" />;
