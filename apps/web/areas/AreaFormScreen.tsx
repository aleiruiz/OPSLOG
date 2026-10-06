import React from 'react';
import { PageHeader } from '@opslog/ui';
import { ResourceView, useResource } from '../app/resource';
import { useRouter } from '../app/router';
import { useSession } from '../auth/session';
import { AreaForm } from './AreaForm';
import { AreaNotEditable, AreaNotFound } from './AreaMessages';
import { areaPath, areasPath } from './AreaTreeView';
import { changes, emptyValues, toInput, valuesOf, type AreaFormValues } from './formModel';
import { loadAllAreas, loadAreaContext, type AreaContext } from './loadAreas';
import { describeFailure, type Failure } from './messages';
import { OPAQUE_ID } from './rules';
import { buildTree, descendantIds, findNode, parentChoices } from './tree';

const noFailure: Failure = { alert: null, fields: {} };

/** Create form. Requires `create`. `?padre=<id>` opens it with that area as the parent ("Nueva sub-área"). */
export function AreaCreateScreen() {
  const { ports, markExpired, state: session } = useSession();
  const router = useRouter();
  const { state, reload } = useResource(() => loadAllAreas(ports.areas, true), [ports]);
  const [submitting, setSubmitting] = React.useState(false);
  const [failure, setFailure] = React.useState<Failure>(noFailure);
  // What was typed survives the reload that follows signing in again (the form is replaced while it loads).
  const draft = React.useRef<AreaFormValues | null>(null);
  const userId =
    session.status === 'authenticated' || session.status === 'expired'
      ? session.session.user.id.replace(/^user-/, '')
      : undefined;

  const remember = React.useCallback((values: AreaFormValues) => {
    draft.current = values;
  }, []);

  const submit = async (values: AreaFormValues) => {
    setSubmitting(true);
    setFailure(noFailure);
    const result = await ports.areas.create(toInput(values));
    setSubmitting(false);
    if (result.ok) {
      draft.current = null;
      router.navigate(`${areaPath(result.value.id)}?aviso=creada`);
    } else {
      if (result.error.status === 401) markExpired();
      setFailure(describeFailure(result.error, 'create'));
    }
  };

  return (
    <>
      <PageHeader
        title="Nueva área"
        description="El área se crea activa. Elige dónde va en la estructura y quiénes la atienden."
      />
      <ResourceView state={state} onRetry={reload}>
        {(catalog) => {
          const choices = parentChoices(buildTree(catalog.areas), null);
          const preset = router.search.get('padre') ?? '';
          const usable =
            OPAQUE_ID.test(preset) && choices.some((c) => c.id === preset && !c.unavailable);
          return (
            <AreaForm
              mode="create"
              initial={draft.current ?? emptyValues(usable ? preset : '')}
              onValuesChange={remember}
              choices={choices}
              {...(userId ? { currentUserId: userId } : {})}
              submitting={submitting}
              serverErrors={failure.fields}
              alert={failure.alert}
              onAlertAction={() => {
                setFailure(noFailure);
                reload();
              }}
              cancelTo={areasPath}
              onSubmit={(values) => void submit(values)}
            />
          );
        }}
      </ResourceView>
    </>
  );
}

/** Unsaved edits that outlive a reload of the area (an expired session reloads it after signing in). */
interface EditDraft {
  values: AreaFormValues;
  baseVersion: number;
}

function EditForm({
  mode,
  context,
  reload,
  draft,
}: {
  mode: 'edit' | 'move';
  context: AreaContext;
  reload: () => void;
  draft: React.MutableRefObject<EditDraft | null>;
}) {
  const { ports, markExpired, state: session } = useSession();
  const router = useRouter();
  const { area } = context;
  const [submitting, setSubmitting] = React.useState(false);
  // Edits are restored only if the area is still at the version they were made on; otherwise they could
  // silently overwrite what another person saved in the meantime.
  const [start] = React.useState(() => {
    const kept = draft.current;
    if (kept && kept.baseVersion === area.version) return { values: kept.values, outdated: false };
    draft.current = null;
    return { values: valuesOf(area), outdated: kept !== null };
  });
  const [failure, setFailure] = React.useState<Failure>({
    alert: start.outdated
      ? {
          severity: 'warning',
          message:
            'El área cambió desde que empezaste a editar. Cargamos los datos actuales: vuelve a hacer tus cambios.',
        }
      : null,
    fields: {},
  });
  const version = area.version;
  const remember = React.useCallback(
    (values: AreaFormValues) => {
      draft.current = { values, baseVersion: draft.current?.baseVersion ?? version };
    },
    [draft, version],
  );
  const tree = React.useMemo(() => buildTree(context.areas), [context.areas]);
  const node = findNode(tree, area.id);
  const choices = React.useMemo(() => parentChoices(tree, node), [tree, node]);
  const userId =
    session.status === 'authenticated' || session.status === 'expired'
      ? session.session.user.id.replace(/^user-/, '')
      : undefined;

  const submit = async (values: AreaFormValues) => {
    const patch = changes(area, values, mode);
    if (!patch) {
      setFailure({
        alert: {
          severity: 'info',
          message:
            mode === 'move' ? 'El área ya está en esa ubicación.' : 'No hay cambios que guardar.',
        },
        fields: {},
      });
      return;
    }
    setSubmitting(true);
    setFailure(noFailure);
    const result = await ports.areas.update(area.id, { version: area.version, ...patch });
    setSubmitting(false);
    if (result.ok) {
      draft.current = null;
      router.navigate(`${areaPath(area.id)}?aviso=${mode === 'move' ? 'movida' : 'guardada'}`);
    } else {
      if (result.error.status === 401) markExpired();
      setFailure(describeFailure(result.error, mode));
    }
  };

  return (
    <AreaForm
      mode={mode}
      initial={start.values}
      onValuesChange={remember}
      choices={choices}
      movingName={area.name}
      movingSubAreas={node ? descendantIds(node).length : 0}
      {...(userId ? { currentUserId: userId } : {})}
      submitting={submitting}
      serverErrors={failure.fields}
      alert={failure.alert}
      onAlertAction={() => {
        draft.current = null;
        reload();
      }}
      cancelTo={areaPath(area.id)}
      onSubmit={(values) => void submit(values)}
    />
  );
}

function EditFlow({ id, mode }: { id: string; mode: 'edit' | 'move' }) {
  const { ports } = useSession();
  const { state, reload, generation } = useResource(
    () => loadAreaContext(ports.areas, id),
    [ports, id],
  );
  const draft = React.useRef<EditDraft | null>(null);
  return (
    <>
      <PageHeader
        title={mode === 'edit' ? 'Editar área' : 'Mover área'}
        description={
          mode === 'edit'
            ? 'Los cambios se guardan sobre la versión que cargaste; si otra persona cambia el área antes, te avisaremos. Para cambiar su ubicación usa «Mover».'
            : 'Cambia el área superior. La estructura de sus sub-áreas se conserva y no puede pasar de 4 niveles.'
        }
      />
      {state.status === 'error' && state.error.status === 404 ? (
        <AreaNotFound />
      ) : (
        <ResourceView state={state} onRetry={reload}>
          {(context) =>
            context.area.active ? (
              <EditForm
                key={generation}
                mode={mode}
                context={context}
                reload={reload}
                draft={draft}
              />
            ) : (
              <AreaNotEditable areaId={context.area.id} />
            )
          }
        </ResourceView>
      )}
    </>
  );
}

/** Edit form (name, code, responsibles). Requires `edit`; inactive areas are read-only. */
export const AreaEditScreen = ({ id }: { id: string }) => <EditFlow id={id} mode="edit" />;

/** Move form (new parent; the subtree travels with the area). Requires `edit`. */
export const AreaMoveScreen = ({ id }: { id: string }) => <EditFlow id={id} mode="move" />;
