import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, Field, FormSection, Notifications, opslogTokens, UiState } from '@opslog/ui';
import { RouterButton } from '../app/router';
import type { ImportEntity, ImportMode } from '../app/types';
import type { FormAlert } from '../documents/DocumentForm';
import {
  emptyValues,
  fieldOrder,
  inspect,
  validate,
  type FieldErrors,
  type FieldKey,
  type ImportFormValues,
} from './formModel';
import { ImportValidationPanel, type ValidationResult } from './ImportValidationPanel';
import { columnLabel, entityLabels, modeDescriptions, modeLabels, modeOrder } from './labels';
import { MAX_CSV_LENGTH, MAX_ROWS, IMPORT_ENTITIES, templateOf } from './rules';

export type { FormAlert, ValidationResult };

export interface ImportFormProps {
  readonly initial?: Partial<ImportFormValues>;
  /** Whether the session holds `view_pii`: only then employee files may carry personal-data columns. */
  readonly canViewPii: boolean;
  readonly submitting?: boolean;
  /** Which mode is running, so only its button shows the spinner. */
  readonly submittingMode?: ImportMode | null;
  readonly validation?: ValidationResult | null;
  readonly alert?: FormAlert | null;
  readonly onAlertAction?: () => void;
  readonly onSubmit: (values: ImportFormValues) => void;
  /** Confirms the validated file in the given mode (`commit_valid` or `commit_all`). */
  readonly onConfirm: (values: ImportFormValues, mode: 'commit_valid' | 'commit_all') => void;
  readonly onRetryRows?: () => void;
  readonly cancelTo: string;
}

const submitLabels: Record<ImportMode, string> = {
  dry_run: 'Validar archivo',
  commit_valid: 'Importar filas válidas',
  commit_all: 'Importar todo o nada',
};

const number = (value: number) => new Intl.NumberFormat('es-MX').format(value);

const list = (columns: readonly string[]) => columns.map(columnLabel).join(', ');

/** Data URL of the template of an entity: its header line (with a byte-order mark so a spreadsheet reads the accents). */
export const templateHref = (entity: ImportEntity): string => {
  const template = templateOf(entity);
  const header = [...template.required, ...template.optional].join(',');
  return `data:text/csv;charset=utf-8,${encodeURIComponent(`﻿${header}\n`)}`;
};

/** Bulk-import form: entity, mode, and the CSV pasted or loaded from a file. Validation mirrors the backend. */
export function ImportForm({
  initial,
  canViewPii,
  submitting = false,
  submittingMode = null,
  validation = null,
  alert = null,
  onAlertAction,
  onSubmit,
  onConfirm,
  onRetryRows,
  cancelTo,
}: ImportFormProps) {
  const uid = React.useId();
  const inputId = (key: FieldKey) => `${uid}-${key}`;
  const [values, setValues] = React.useState<ImportFormValues>(() => ({
    ...emptyValues,
    ...initial,
  }));
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [clientErrors, setClientErrors] = React.useState<FieldErrors>({});
  const alertRef = React.useRef<HTMLDivElement>(null);
  const errors = clientErrors;

  const focusField = (key: FieldKey) => globalThis.document.getElementById(inputId(key))?.focus();

  React.useEffect(() => {
    if (alert) alertRef.current?.focus();
  }, [alert]);

  const setField = <K extends FieldKey>(key: K, value: ImportFormValues[K]) => {
    setValues((existing) => ({ ...existing, [key]: value }));
    setClientErrors((existing) => (existing[key] ? { ...existing, [key]: undefined } : existing));
  };

  const run = (next: ImportFormValues) => {
    if (submitting) return;
    const found = validate(next, { canViewPii });
    const first = fieldOrder.find((key) => found[key]);
    setClientErrors(found);
    if (first) focusField(first);
    else onSubmit(next);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    run(values);
  };

  const readFile = (file: File) => {
    if (file.size > MAX_CSV_LENGTH * 4) {
      setClientErrors({ csv: 'El archivo es demasiado grande. Divídelo en varios archivos.' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setFileName(file.name);
      setField('csv', typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () =>
      setClientErrors({ csv: 'No pudimos leer el archivo. Intenta con otro o pega las filas.' });
    reader.readAsText(file, 'utf-8');
  };

  const found = values.csv.trim() ? inspect(values.csv, values.entity) : null;
  const template = templateOf(values.entity);
  const piiColumns = template.pii;
  const grid = { display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } };

  return (
    <form onSubmit={submit} noValidate aria-label="Nueva importación">
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, maxWidth: 840 }}>
        {alert && (
          <Box ref={alertRef} tabIndex={-1} sx={{ outline: 'none' }}>
            {alert.severity === 'error' ? (
              <UiState
                kind="error"
                title={alert.title ?? 'No pudimos importar el archivo'}
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
        <Notifications
          messages={[
            {
              id: 'privacy',
              text: 'El informe muestra solo el número de fila, el motivo y las columnas con problema: nunca el contenido de las celdas. Las filas se envían al servidor solo al validar o importar.',
              severity: 'info',
            },
            ...(values.entity === 'employee'
              ? [
                  {
                    id: 'pii',
                    text: canViewPii
                      ? `Las columnas ${list(piiColumns)} contienen datos personales. Tu rol puede importarlas: se cifran al guardarse y no aparecen en el informe.`
                      : `Las columnas ${list(piiColumns)} contienen datos personales. Tu rol no puede importarlas (requiere permiso para ver datos personales): quítalas del archivo.`,
                    severity: canViewPii ? ('info' as const) : ('warning' as const),
                  },
                ]
              : []),
            ...(values.mode !== 'dry_run'
              ? [
                  {
                    id: 'commit-note',
                    text: 'Este modo crea registros reales. Te recomendamos validar el archivo antes. Si reintentas por un fallo de conexión, la importación no se duplica.',
                    severity: 'warning' as const,
                  },
                ]
              : []),
          ]}
        />
        <FormSection
          title="Qué importar"
          description="Los campos marcados con asterisco son obligatorios."
        >
          <Box sx={grid}>
            <Field
              id={inputId('entity')}
              label="Registros a importar"
              select
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true }}
              value={values.entity}
              onChange={(event) => setField('entity', event.target.value as ImportEntity)}
              required
              error={Boolean(errors.entity)}
              {...(errors.entity ? { helperText: errors.entity } : {})}
              fullWidth
            >
              {IMPORT_ENTITIES.map((entity) => (
                <option key={entity} value={entity}>
                  {entityLabels[entity]}
                </option>
              ))}
            </Field>
            <Field
              id={inputId('mode')}
              label="Qué hacer con el archivo"
              select
              SelectProps={{ native: true }}
              InputLabelProps={{ shrink: true }}
              value={values.mode}
              onChange={(event) => setField('mode', event.target.value as ImportMode)}
              required
              error={Boolean(errors.mode)}
              helperText={errors.mode ?? modeDescriptions[values.mode]}
              fullWidth
            >
              {modeOrder.map((mode) => (
                <option key={mode} value={mode}>
                  {modeLabels[mode]}
                </option>
              ))}
            </Field>
          </Box>
        </FormSection>
        <FormSection
          title="Plantilla de columnas"
          description="La primera línea del archivo es el encabezado con estos nombres, separados por comas."
        >
          <Typography variant="body2">
            <strong>Obligatorias:</strong>{' '}
            <Box component="span" sx={{ fontFamily: opslogTokens.typography.monoFamily }}>
              {template.required.join(', ')}
            </Box>
          </Typography>
          <Typography variant="body2">
            <strong>Opcionales:</strong>{' '}
            <Box component="span" sx={{ fontFamily: opslogTokens.typography.monoFamily }}>
              {template.optional.join(', ')}
            </Box>
          </Typography>
          <Typography variant="body2">
            Hasta {number(MAX_ROWS)} filas por archivo.{' '}
            <Box
              component="a"
              href={templateHref(values.entity)}
              download={`plantilla-${values.entity === 'vehicle' ? 'vehiculos' : 'empleados'}.csv`}
              sx={{ color: 'primary.main', textDecoration: 'underline' }}
            >
              Descargar plantilla
            </Box>
          </Typography>
        </FormSection>
        <FormSection
          title="Archivo"
          description="Carga un archivo CSV o pega las filas. El archivo se lee en tu navegador."
        >
          <Box>
            <Typography
              component="label"
              htmlFor={`${uid}-file`}
              variant="body2"
              sx={{ display: 'block', mb: 0.5 }}
            >
              Cargar archivo CSV
            </Typography>
            <input
              id={`${uid}-file`}
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) readFile(file);
                event.target.value = '';
              }}
            />
            {fileName && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                Archivo cargado: {fileName}
              </Typography>
            )}
          </Box>
          <Field
            id={inputId('csv')}
            label="Contenido CSV"
            value={values.csv}
            onChange={(event) => {
              setFileName(null);
              setField('csv', event.target.value);
            }}
            required
            multiline
            minRows={8}
            error={Boolean(errors.csv)}
            helperText={
              errors.csv ??
              (found?.readable
                ? `Detectamos ${number(found.rows)} filas y ${number(found.columns.length)} columnas.`
                : 'Encabezado y filas, una por línea.')
            }
            inputProps={{ spellCheck: false }}
            sx={{ '& textarea': { fontFamily: opslogTokens.typography.monoFamily } }}
            fullWidth
          />
        </FormSection>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          <Button
            type="submit"
            variant="contained"
            loading={submitting && submittingMode === values.mode}
            disabled={submitting && submittingMode !== values.mode}
          >
            {submitLabels[values.mode]}
          </Button>
          <RouterButton to={cancelTo} variant="text">
            Cancelar
          </RouterButton>
        </Box>
        {validation && (
          <ImportValidationPanel
            result={validation}
            values={values}
            submitting={submitting ? submittingMode : null}
            onConfirm={onConfirm}
            onRetryRows={onRetryRows}
          />
        )}
      </Box>
    </form>
  );
}
