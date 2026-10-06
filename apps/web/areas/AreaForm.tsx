import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, Field, FormSection, Notifications, opslogTokens, UiState } from '@opslog/ui';
import { RouterButton } from '../app/router';
import {
  emptyValues,
  fieldOrder,
  responsibleProblem,
  validate,
  type AreaFormValues,
  type FieldErrors,
  type FieldKey,
  type FormMode,
} from './formModel';
import { count } from './labels';
import type { FormAlert } from './messages';
import { MAX_RESPONSIBLES } from './rules';
import type { ParentChoice } from './tree';

export type { FormAlert };

export interface AreaFormProps {
  readonly mode: FormMode;
  /** Values the form opens with (create: empty or with a preset parent; edit/move: the loaded area). */
  readonly initial?: AreaFormValues;
  /** Candidate parents (create and move). */
  readonly choices?: readonly ParentChoice[];
  /** Move: the area being moved, and how many sub-areas travel with it. */
  readonly movingName?: string;
  readonly movingSubAreas?: number;
  /** The signed-in user, offered as a quick "add me" responsible (identities are opaque ids). */
  readonly currentUserId?: string;
  readonly submitting?: boolean;
  /** Field messages that came back from the server (duplicates, rejected parent or responsibles). */
  readonly serverErrors?: FieldErrors;
  readonly alert?: FormAlert | null;
  readonly onAlertAction?: () => void;
  readonly onSubmit: (values: AreaFormValues) => void;
  /** Reports every edit, so a parent can keep unsaved values across a reload. */
  readonly onValuesChange?: (values: AreaFormValues) => void;
  /** Where "Cancelar" goes. */
  readonly cancelTo: string;
}

const titles: Record<FormMode, string> = {
  create: 'Nueva área',
  edit: 'Editar área',
  move: 'Mover área',
};
const submitLabels: Record<FormMode, string> = {
  create: 'Crear área',
  edit: 'Guardar cambios',
  move: 'Mover área',
};

/** Create / edit / move form of an area. Validation mirrors the backend; the server's answers arrive as props. */
export function AreaForm({
  mode,
  initial,
  choices = [],
  movingName,
  movingSubAreas = 0,
  currentUserId,
  submitting = false,
  serverErrors,
  alert = null,
  onAlertAction,
  onSubmit,
  onValuesChange,
  cancelTo,
}: AreaFormProps) {
  const uid = React.useId();
  const inputId = (key: FieldKey) => `${uid}-${key}`;
  const [values, setValues] = React.useState<AreaFormValues>(() => initial ?? emptyValues());
  const [clientErrors, setClientErrors] = React.useState<FieldErrors>({});
  const [pending, setPending] = React.useState('');
  const [pendingError, setPendingError] = React.useState<string | null>(null);
  const alertRef = React.useRef<HTMLDivElement>(null);
  const errors: FieldErrors = { ...serverErrors, ...clientErrors };

  const focusField = (key: FieldKey) => document.getElementById(inputId(key))?.focus();

  // A failed save moves focus to what the person must read: the first field the server rejected, else the alert.
  React.useEffect(() => {
    const first = fieldOrder.find((key) => serverErrors?.[key]);
    if (first) focusField(first);
    else if (alert) alertRef.current?.focus();
  }, [serverErrors, alert]);

  const changed = React.useRef(false);
  React.useEffect(() => {
    // Only real edits are reported, never the initial values.
    if (changed.current) onValuesChange?.(values);
  }, [values, onValuesChange]);

  const setField = (key: 'name' | 'code' | 'parentId', value: string) => {
    changed.current = true;
    setValues((current) => ({ ...current, [key]: value }));
    setClientErrors((current) => {
      const fieldKey: FieldKey = key;
      return current[fieldKey] ? { ...current, [fieldKey]: undefined } : current;
    });
  };

  const setResponsibles = (ids: readonly string[]) => {
    changed.current = true;
    setValues((current) => ({ ...current, responsibleIds: ids }));
    setClientErrors((current) =>
      current.responsibles ? { ...current, responsibles: undefined } : current,
    );
  };

  const addResponsible = (text: string) => {
    const problem = responsibleProblem(text, values.responsibleIds);
    setPendingError(problem);
    if (problem) return false;
    setResponsibles([...values.responsibleIds, text.trim()].sort());
    setPending('');
    return true;
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const found = validate(values, { mode, choices });
    if (pending.trim() !== '' && !found.responsibles && mode !== 'move')
      found.responsibles =
        'Escribiste un identificador sin agregarlo: usa «Agregar» o bórralo antes de guardar.';
    const first = fieldOrder.find((key) => found[key]);
    setClientErrors(found);
    if (first) focusField(first);
    else onSubmit(values);
  };

  const showFields = mode !== 'move';
  const showParent = mode !== 'edit';
  const parentError = errors.parentId;
  const responsiblesError = errors.responsibles ?? pendingError ?? undefined;

  return (
    <form onSubmit={submit} noValidate aria-label={titles[mode]}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 720 }}>
        {alert && (
          <Box ref={alertRef} tabIndex={-1} sx={{ outline: 'none' }}>
            {alert.severity === 'error' ? (
              <UiState
                kind="error"
                title={alert.title ?? 'No pudimos guardar el área'}
                description={alert.message}
                {...(alert.actionLabel && onAlertAction
                  ? { actionLabel: alert.actionLabel, onAction: onAlertAction }
                  : {})}
              />
            ) : (
              <Notifications
                messages={[{ id: 'form-alert', text: alert.message, severity: alert.severity }]}
              />
            )}
          </Box>
        )}
        {showFields && (
          <FormSection
            title="Datos del área"
            description="Los campos marcados con asterisco son obligatorios."
          >
            <Box
              sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}
            >
              <Field
                id={inputId('name')}
                label="Nombre"
                value={values.name}
                onChange={(event) => setField('name', event.target.value)}
                required
                error={Boolean(errors.name)}
                helperText={
                  errors.name ?? 'Único entre las áreas del mismo nivel; no distingue mayúsculas.'
                }
                fullWidth
              />
              <Field
                id={inputId('code')}
                label="Código"
                value={values.code}
                onChange={(event) => setField('code', event.target.value)}
                error={Boolean(errors.code)}
                helperText={
                  errors.code ?? 'Opcional. Único en tu empresa; se guarda en mayúsculas.'
                }
                sx={{ '& input': { fontFamily: opslogTokens.typography.monoFamily } }}
                fullWidth
              />
            </Box>
          </FormSection>
        )}
        {showParent && (
          <FormSection
            title="Ubicación"
            description={
              mode === 'move'
                ? `Elige la nueva área superior de «${movingName ?? 'esta área'}».`
                : 'Las áreas forman un árbol de hasta 4 niveles.'
            }
          >
            {mode === 'move' && (
              <Notifications
                messages={[
                  {
                    id: 'move-info',
                    severity: 'info',
                    text:
                      movingSubAreas > 0
                        ? `Se moverán también sus ${count(movingSubAreas, 'sub-área', 'sub-áreas')} con la misma estructura.`
                        : 'Esta área no tiene sub-áreas: solo ella cambia de lugar.',
                  },
                ]}
              />
            )}
            <Field
              id={inputId('parentId')}
              label="Área superior"
              select
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true }}
              value={values.parentId}
              onChange={(event) => setField('parentId', event.target.value)}
              error={Boolean(parentError)}
              helperText={
                parentError ??
                'Las áreas inactivas o que superarían los 4 niveles aparecen deshabilitadas.'
              }
              fullWidth
            >
              <option value="">Ninguna: área raíz</option>
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id} disabled={choice.unavailable !== null}>
                  {choice.label}
                </option>
              ))}
            </Field>
          </FormSection>
        )}
        {showFields && (
          <FormSection
            title="Responsables"
            description="Reciben las notificaciones del área. Se identifican por el identificador de usuario; los nombres no se muestran."
          >
            <Box
              role="group"
              aria-labelledby={`${uid}-resp-title`}
              sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}
            >
              <Typography id={`${uid}-resp-title`} variant="body2" color="text.secondary">
                {count(values.responsibleIds.length, 'responsable', 'responsables')} de{' '}
                {MAX_RESPONSIBLES} como máximo
              </Typography>
              {values.responsibleIds.length > 0 && (
                <Box component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }}>
                  {values.responsibleIds.map((id) => (
                    <Box
                      component="li"
                      key={id}
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 1,
                        flexWrap: 'wrap',
                        py: 0.25,
                      }}
                    >
                      <Typography
                        component="span"
                        sx={{
                          fontFamily: opslogTokens.typography.monoFamily,
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {id}
                      </Typography>
                      <Button
                        variant="text"
                        size="small"
                        aria-label={`Quitar a ${id}`}
                        onClick={() =>
                          setResponsibles(values.responsibleIds.filter((item) => item !== id))
                        }
                      >
                        Quitar
                      </Button>
                    </Box>
                  ))}
                </Box>
              )}
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'flex-start' }}>
                <Field
                  id={inputId('responsibles')}
                  label="Agregar responsable"
                  value={pending}
                  onChange={(event) => {
                    setPending(event.target.value);
                    setPendingError(null);
                    setClientErrors((current) =>
                      current.responsibles ? { ...current, responsibles: undefined } : current,
                    );
                  }}
                  onKeyDown={(event) => {
                    // Enter adds the identifier instead of submitting the whole form.
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addResponsible(pending);
                    }
                  }}
                  error={Boolean(responsiblesError)}
                  helperText={responsiblesError ?? 'Identificador de usuario, por ejemplo ana.'}
                  sx={{
                    flex: '1 1 240px',
                    '& input': { fontFamily: opslogTokens.typography.monoFamily },
                  }}
                />
                <Button variant="outlined" onClick={() => addResponsible(pending)}>
                  Agregar
                </Button>
              </Box>
              {currentUserId && !values.responsibleIds.includes(currentUserId) && (
                <Box>
                  <Button variant="text" size="small" onClick={() => addResponsible(currentUserId)}>
                    Agregarme como responsable
                  </Button>
                </Box>
              )}
            </Box>
          </FormSection>
        )}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          <Button type="submit" variant="contained" loading={submitting}>
            {submitLabels[mode]}
          </Button>
          <RouterButton to={cancelTo} variant="text">
            Cancelar
          </RouterButton>
        </Box>
      </Box>
    </form>
  );
}
