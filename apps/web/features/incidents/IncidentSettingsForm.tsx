import React from 'react';
import Box from '@mui/material/Box';
import { Button, Field, FormSection, InlineAlert, Panel } from '@opslog/ui';
import type { BffAlertSettings, BffIncidentReportPhoto } from '@opslog/contracts';
import { SEVERITY_LABELS } from './labels';
import {
  SEVERITY_ORDER,
  applyEdits,
  toInput,
  valuesOf,
  validate,
  type SettingsEdits,
  type SettingsField,
} from './settingsModel';
import type { IncidentPorts } from './ports';
import { describeError, isStale } from './errors';

const SETTINGS_STALE_COPY =
  'La configuración cambió mientras la editabas. Recarga para ver la versión actual: lo que escribiste y aún no guardaste se conserva.';

const PHOTO_LABELS: Readonly<Record<BffIncidentReportPhoto, string>> = {
  photo_or_justification: 'Una foto revisada o una justificación',
  photo_required: 'Siempre una foto revisada',
};

/**
 * Configuración de siniestros: the photo rule at report time, the SLA days per severity, the days without
 * movement before a case is flagged, and the D20 threshold. What the person typed is kept apart from the
 * saved settings, so after a conflict "Recargar" brings the current settings and keeps the typed values.
 */
export function IncidentSettingsForm({
  settings,
  ports,
  onSaved,
  onReload,
  onExpired,
}: {
  settings: BffAlertSettings;
  ports: IncidentPorts;
  onSaved: (settings: BffAlertSettings) => void;
  onReload: () => void;
  onExpired: () => void;
}) {
  const base = valuesOf(settings);
  const [edits, setEdits] = React.useState<SettingsEdits>({});
  const [busy, setBusy] = React.useState(false);
  const [tried, setTried] = React.useState(false);
  const [notice, setNotice] = React.useState<{
    kind: 'ok' | 'error' | 'stale';
    text: string;
  } | null>(null);
  const id = React.useId();
  const values = applyEdits(base, edits);
  const problems = validate(values);
  const dirty = Object.keys(edits).length > 0;
  const problem = (field: SettingsField) => (tried ? problems[field] : undefined);
  const note = (field: SettingsField) => {
    const text = problem(field);
    return { error: text !== undefined, ...(text ? { helperText: text } : {}) };
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setTried(true);
    if (Object.keys(problems).length > 0) return;
    setBusy(true);
    setNotice(null);
    const result = await ports.settings.save(toInput(settings, values));
    setBusy(false);
    if (result.ok) {
      setEdits({});
      setTried(false);
      onSaved(result.value);
      setNotice({ kind: 'ok', text: 'Configuración guardada.' });
      return;
    }
    if (result.error.status === 401) onExpired();
    setNotice(
      isStale(result.error)
        ? { kind: 'stale', text: SETTINGS_STALE_COPY }
        : { kind: 'error', text: describeError(result.error, 'guardar la configuración') },
    );
  };

  return (
    <Panel>
      <Box
        component="form"
        aria-label="Configuración de siniestros"
        noValidate
        onSubmit={(event: React.FormEvent) => void submit(event)}
        sx={{ display: 'grid', gap: 3, maxWidth: 760 }}
      >
        {notice && (
          <InlineAlert
            severity={
              notice.kind === 'ok' ? 'success' : notice.kind === 'stale' ? 'warning' : 'error'
            }
            {...(notice.kind === 'stale'
              ? {
                  action: (
                    <Button
                      color="inherit"
                      onClick={() => {
                        setNotice(null);
                        onReload();
                      }}
                    >
                      Recargar
                    </Button>
                  ),
                }
              : {})}
          >
            {notice.text}
          </InlineAlert>
        )}
        <FormSection
          title="Reporte"
          description="Qué evidencia pide el sistema para reportar un siniestro."
        >
          <Field
            id={`${id}-photo`}
            label="Foto al reportar"
            select
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true }}
            value={values.photo}
            onChange={(event) =>
              setEdits({ ...edits, photo: event.target.value as BffIncidentReportPhoto })
            }
          >
            {(Object.keys(PHOTO_LABELS) as BffIncidentReportPhoto[]).map((value) => (
              <option key={value} value={value}>
                {PHOTO_LABELS[value]}
              </option>
            ))}
          </Field>
        </FormSection>
        <FormSection
          title="Plazo de resolución"
          description="Días naturales para resolver un caso, según su gravedad. Aplica a los casos que se reporten o reabran después del cambio."
        >
          {SEVERITY_ORDER.map((severity) => (
            <Field
              key={severity}
              id={`${id}-days-${severity}`}
              label={`Días para casos de gravedad ${SEVERITY_LABELS[severity].toLowerCase()}`}
              value={values.days[severity]}
              inputProps={{ inputMode: 'numeric' }}
              {...note(`days.${severity}`)}
              onChange={(event) =>
                setEdits({ ...edits, days: { ...edits.days, [severity]: event.target.value } })
              }
            />
          ))}
        </FormSection>
        <FormSection
          title="Casos sin movimiento"
          description="Pasados estos días sin cambios el caso se avisa; al doble de días se escala a quien aprueba."
        >
          <Field
            id={`${id}-inactivity`}
            label="Días sin movimiento"
            value={values.inactivity}
            inputProps={{ inputMode: 'numeric' }}
            {...note('inactivity')}
            onChange={(event) => setEdits({ ...edits, inactivity: event.target.value })}
          />
        </FormSection>
        {settings.closeCostThreshold !== undefined && (
          <FormSection
            title="Aprobación de costos"
            description="Si el costo a cargo de la empresa pasa de este umbral, el cierre y la asunción piden la aprobación de una persona supervisora. Déjalo vacío para no pedirla."
          >
            <Field
              id={`${id}-threshold`}
              label="Umbral de aprobación (opcional)"
              value={values.thresholdAmount}
              inputProps={{ inputMode: 'decimal' }}
              {...note('threshold')}
              onChange={(event) => setEdits({ ...edits, thresholdAmount: event.target.value })}
            />
            <Field
              id={`${id}-currency`}
              label="Moneda del umbral"
              value={values.thresholdCurrency}
              {...note('currency')}
              onChange={(event) =>
                setEdits({ ...edits, thresholdCurrency: event.target.value.toUpperCase() })
              }
            />
          </FormSection>
        )}
        <Box>
          <Button type="submit" variant="contained" loading={busy} disabled={!dirty}>
            Guardar configuración
          </Button>
        </Box>
      </Box>
    </Panel>
  );
}
