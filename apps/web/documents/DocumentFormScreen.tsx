import React from 'react';
import { PageHeader } from '@opslog/ui';
import { ResourceView, useResource } from '../app/resource';
import { useRouter } from '../app/router';
import type { ApiError, Document } from '../app/types';
import { useVehicleName } from '../app/useVehicleName';
import { loadVehicleOptions } from '../app/vehicleOptions';
import { useSession } from '../auth/session';
import { DocumentForm, type FormAlert } from './DocumentForm';
import {
  DocumentNotEditable,
  DocumentNotFound,
  documentPath,
  documentsPath,
} from './DocumentMessages';
import {
  changes,
  editValuesOf,
  ownerErrors,
  renewalValuesOf,
  toInput,
  toRenewal,
  type DocumentFormValues,
  type FieldErrors,
  type FormMode,
} from './formModel';
import { isEditable } from './labels';

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
        'Otra persona modificó este documento',
        `Cambió mientras lo trabajabas. Tus cambios no se guardaron. Carga los datos actuales y vuelve a hacer tus cambios.`,
        RELOAD,
      ),
      fields: {},
    };
  if (error.code === 'immutable')
    return {
      alert: fail(
        'El documento ya no admite cambios',
        'Se archivó mientras lo trabajabas. Tus cambios no se guardaron.',
      ),
      fields: {},
    };
  if (error.code === 'invalid_owner')
    return {
      alert: fail(
        'El vehículo no es válido',
        mode === 'create'
          ? 'El vehículo no existe o está archivado. Elige otro vehículo de la lista.'
          : 'El vehículo de este documento ya no existe o está archivado, por lo que no se puede renovar.',
      ),
      fields: ownerErrors(error),
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
      alert: fail('No tienes permiso', `Tu rol no permite ${verb} documentos.`),
      fields: {},
    };
  if (error.status === 404)
    return { alert: fail('El documento ya no existe', 'No se guardó ningún cambio.'), fields: {} };
  return {
    alert: fail(`No pudimos ${verb} el documento`, 'Intenta nuevamente.'),
    fields: {},
  };
}

/** Create form. Requires `create`. */
export function DocumentCreateScreen() {
  const { ports, markExpired } = useSession();
  const router = useRouter();
  const vehicles = useResource(() => loadVehicleOptions(ports.vehicles), [ports]);
  const [submitting, setSubmitting] = React.useState(false);
  const [failure, setFailure] = React.useState<Failure>(none);

  const submit = async (values: DocumentFormValues) => {
    setSubmitting(true);
    setFailure(none);
    const result = await ports.documents.create(toInput(values));
    setSubmitting(false);
    if (result.ok) router.navigate(`${documentPath(result.value.id)}?aviso=creado`);
    else {
      if (result.error.status === 401) markExpired();
      setFailure(describeFailure(result.error, 'create'));
    }
  };

  return (
    <>
      <PageHeader
        title="Nuevo documento"
        description="Registra los datos del documento de un vehículo y cuándo vence. Los archivos llegarán más adelante."
      />
      <ResourceView state={vehicles.state} onRetry={vehicles.reload}>
        {(options) => (
          <DocumentForm
            mode="create"
            vehicles={options}
            submitting={submitting}
            serverErrors={failure.fields}
            alert={failure.alert}
            cancelTo={documentsPath}
            onSubmit={(values) => void submit(values)}
          />
        )}
      </ResourceView>
    </>
  );
}

/** Unsaved edits that outlive a reload of the document (an expired session reloads it after signing in). */
interface Draft {
  values: DocumentFormValues;
  baseVersion: number;
}

function ChangeForm({
  mode,
  document,
  setDocument,
  reload,
  draft,
}: {
  mode: 'edit' | 'renew';
  document: Document;
  setDocument: (document: Document) => void;
  reload: () => void;
  draft: React.MutableRefObject<Draft | null>;
}) {
  const { ports, markExpired } = useSession();
  const router = useRouter();
  const ownerName = useVehicleName(document.ownerType === 'vehicle' ? document.ownerId : null);
  const [submitting, setSubmitting] = React.useState(false);
  // Edits are restored only if the document is still at the version they were made on; otherwise they could
  // silently overwrite what another person saved in the meantime.
  const [start] = React.useState(() => {
    const kept = draft.current;
    if (kept && kept.baseVersion === document.version)
      return { values: kept.values, outdated: false };
    draft.current = null;
    return {
      values: mode === 'edit' ? editValuesOf(document) : renewalValuesOf(document),
      outdated: kept !== null,
    };
  });
  const [failure, setFailure] = React.useState<Failure>({
    alert: start.outdated
      ? {
          severity: 'warning',
          message:
            'El documento cambió desde que empezaste. Cargamos los datos actuales: vuelve a hacer tus cambios.',
        }
      : null,
    fields: {},
  });
  const version = document.version;
  // Stable identity: the form reports edits only when they change, never on an unrelated re-render.
  const remember = React.useCallback(
    (values: DocumentFormValues) => {
      draft.current = { values, baseVersion: draft.current?.baseVersion ?? version };
    },
    [draft, version],
  );

  const submit = async (values: DocumentFormValues) => {
    if (mode === 'edit') {
      const patch = changes(document, values);
      if (!patch) {
        setFailure({
          alert: { severity: 'info', message: 'No hay cambios que guardar.' },
          fields: {},
        });
        return;
      }
      setSubmitting(true);
      setFailure(none);
      const result = await ports.documents.update(document.id, { version, ...patch });
      setSubmitting(false);
      if (result.ok) {
        setDocument(result.value);
        router.navigate(`${documentPath(document.id)}?aviso=guardado`);
      } else {
        if (result.error.status === 401) markExpired();
        setFailure(describeFailure(result.error, 'edit'));
      }
      return;
    }
    setSubmitting(true);
    setFailure(none);
    const result = await ports.documents.renew(document.id, { version, ...toRenewal(values) });
    setSubmitting(false);
    if (result.ok) {
      setDocument(result.value);
      router.navigate(`${documentPath(document.id)}?aviso=renovado`);
    } else {
      if (result.error.status === 401) markExpired();
      setFailure(describeFailure(result.error, 'renew'));
    }
  };

  return (
    <DocumentForm
      mode={mode}
      initial={start.values}
      document={document}
      {...(ownerName ? { ownerName } : {})}
      onValuesChange={remember}
      submitting={submitting}
      serverErrors={failure.fields}
      alert={failure.alert}
      onAlertAction={() => {
        draft.current = null;
        reload();
      }}
      cancelTo={documentPath(document.id)}
      onSubmit={(values) => void submit(values)}
    />
  );
}

function ChangeScreen({ id, mode }: { id: string; mode: 'edit' | 'renew' }) {
  const { ports } = useSession();
  const { state, reload, setData, generation } = useResource(
    () => ports.documents.get(id),
    [ports, id],
  );
  const draft = React.useRef<Draft | null>(null);
  return (
    <>
      <PageHeader
        title={mode === 'edit' ? 'Editar documento' : 'Renovar documento'}
        description={
          mode === 'edit'
            ? 'Aquí cambias el título y las notas. Para corregir una fecha, renueva el documento.'
            : 'Registra la nueva vigencia. Si otra persona cambia el documento antes, te avisaremos.'
        }
      />
      {state.status === 'error' && state.error.status === 404 ? (
        <DocumentNotFound />
      ) : (
        <ResourceView state={state} onRetry={reload}>
          {(document) =>
            isEditable(document) ? (
              <ChangeForm
                key={generation}
                mode={mode}
                document={document}
                setDocument={setData}
                reload={reload}
                draft={draft}
              />
            ) : (
              <DocumentNotEditable documentId={document.id} />
            )
          }
        </ResourceView>
      )}
    </>
  );
}

/** Edit form (title and notes). Requires `edit`; archived documents are read-only. */
export const DocumentEditScreen = ({ id }: { id: string }) => <ChangeScreen id={id} mode="edit" />;

/** Renewal form (a new revision). Requires `edit`; archived documents are read-only. */
export const DocumentRenewScreen = ({ id }: { id: string }) => (
  <ChangeScreen id={id} mode="renew" />
);
