import React from 'react';
import { PageHeader } from '@opslog/ui';
import { ResourceView, useResource } from '../app/resource';
import { useRouter } from '../app/router';
import type { EmployeeDetail } from '../app/types';
import { areaChoices, type AreaChoice } from '../areas/areaChoices';
import { loadAllAreas } from '../areas/loadAreas';
import { useSession } from '../auth/session';
import { EmployeeForm } from './EmployeeForm';
import {
  EmployeeNotEditable,
  EmployeeNotFound,
  employeePath,
  employeesPath,
} from './EmployeeMessages';
import { changes, toInput, valuesOf, type EmployeeFormValues } from './formModel';
import { isEditable } from './labels';
import { describeFailure, type Failure } from './messages';

const noFailure: Failure = { alert: null, fields: {} };

/** Create form. Requires `create`; personal data fields exist only for a session that holds `view_pii`. */
export function EmployeeCreateScreen() {
  const { ports, can, markExpired } = useSession();
  const router = useRouter();
  const canEditPii = can('view_pii');
  const catalog = useResource(() => loadAllAreas(ports.areas, true), [ports]);
  const [submitting, setSubmitting] = React.useState(false);
  const [failure, setFailure] = React.useState<Failure>(noFailure);

  const submit = async (values: EmployeeFormValues) => {
    setSubmitting(true);
    setFailure(noFailure);
    const result = await ports.employees.create(toInput(values, canEditPii));
    setSubmitting(false);
    if (result.ok) router.navigate(`${employeePath(result.value.id)}?aviso=creado`);
    else {
      if (result.error.status === 401) markExpired();
      setFailure(describeFailure(result.error, 'create'));
    }
  };

  return (
    <>
      <PageHeader
        title="Nuevo empleado"
        description="El empleado se crea con estado Activo. Después podrás cambiar su estado con un motivo."
      />
      <ResourceView state={catalog.state} onRetry={catalog.reload}>
        {({ areas }) => (
          <EmployeeForm
            mode="create"
            areas={areaChoices(areas)}
            canEditPii={canEditPii}
            submitting={submitting}
            serverErrors={failure.fields}
            alert={failure.alert}
            cancelTo={employeesPath}
            onSubmit={(values) => void submit(values)}
          />
        )}
      </ResourceView>
    </>
  );
}

/** Unsaved edits that outlive a reload of the employee (an expired session reloads it after signing in). */
interface EditDraft {
  values: EmployeeFormValues;
  baseVersion: number;
}

function EditForm({
  employee,
  areas,
  reload,
  draft,
}: {
  employee: EmployeeDetail;
  areas: readonly AreaChoice[];
  reload: () => void;
  draft: React.MutableRefObject<EditDraft | null>;
}) {
  const { ports, can, markExpired } = useSession();
  const router = useRouter();
  // Personal data is editable only when the session may see it and the server actually sent it.
  const canEditPii = can('view_pii') && employee.pii !== null;
  const [submitting, setSubmitting] = React.useState(false);
  // Edits are restored only if the employee is still at the version they were made on; otherwise they could
  // silently overwrite what another person saved in the meantime.
  const [start] = React.useState(() => {
    const kept = draft.current;
    if (kept && kept.baseVersion === employee.version)
      return { values: kept.values, outdated: false };
    draft.current = null;
    return { values: valuesOf(employee), outdated: kept !== null };
  });
  const [failure, setFailure] = React.useState<Failure>({
    alert: start.outdated
      ? {
          severity: 'warning',
          message:
            'El empleado cambió desde que empezaste a editar. Cargamos los datos actuales: vuelve a hacer tus cambios.',
        }
      : null,
    fields: {},
  });
  const detail = employeePath(employee.id);
  const version = employee.version;
  // Stable identity: the form reports edits only when they change, never on an unrelated re-render.
  const remember = React.useCallback(
    (values: EmployeeFormValues) => {
      draft.current = { values, baseVersion: draft.current?.baseVersion ?? version };
    },
    [draft, version],
  );

  const submit = async (values: EmployeeFormValues) => {
    const patch = changes(employee, values, canEditPii);
    if (!patch) {
      setFailure({
        alert: { severity: 'info', message: 'No hay cambios que guardar.' },
        fields: {},
      });
      return;
    }
    setSubmitting(true);
    setFailure(noFailure);
    const result = await ports.employees.update(employee.id, { version, ...patch });
    setSubmitting(false);
    if (result.ok) router.navigate(`${detail}?aviso=guardado`);
    else {
      if (result.error.status === 401) markExpired();
      setFailure(describeFailure(result.error, 'edit'));
    }
  };

  return (
    <EmployeeForm
      mode="edit"
      areas={areas}
      initial={start.values}
      canEditPii={canEditPii}
      piiPresent={employee.piiPresent}
      onValuesChange={remember}
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

/** Edit form. Requires `edit`; archived and terminated employees are read-only. */
export function EmployeeEditScreen({ id }: { id: string }) {
  const { ports } = useSession();
  const { state, reload, generation } = useResource(() => ports.employees.get(id), [ports, id]);
  const catalog = useResource(() => loadAllAreas(ports.areas, true), [ports]);
  const draft = React.useRef<EditDraft | null>(null);
  return (
    <>
      <PageHeader
        title="Editar empleado"
        description="Los cambios se guardan sobre la versión que cargaste; si otra persona cambia al empleado antes, te avisaremos."
      />
      {state.status === 'error' && state.error.status === 404 ? (
        <EmployeeNotFound />
      ) : (
        <ResourceView state={state} onRetry={reload}>
          {(employee) =>
            isEditable(employee) ? (
              <ResourceView state={catalog.state} onRetry={catalog.reload}>
                {({ areas }) => (
                  <EditForm
                    key={generation}
                    employee={employee}
                    areas={areaChoices(areas, employee.areaId)}
                    reload={reload}
                    draft={draft}
                  />
                )}
              </ResourceView>
            ) : (
              <EmployeeNotEditable employeeId={employee.id} />
            )
          }
        </ResourceView>
      )}
    </>
  );
}
