import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, Field, FormSection, Notifications, opslogTokens, UiState } from '@opslog/ui';
import type { ResourceState } from '../app/resource';
import { RouterButton, RouterLink } from '../app/router';
import type { ImportEntity, ImportJob, ImportMode, ImportRow } from '../app/types';
import type { FormAlert } from '../documents/DocumentForm';
import {
  emptyValues,
  fieldOrder,
  fileSignatureOf,
  inspect,
  validate,
  type FieldErrors,
  type FieldKey,
  type ImportFormValues,
} from './formModel';
import { ImportRowsTable } from './ImportRowsTable';
import { importPath } from './ImportMessages';
import { columnLabel, entityLabels, modeDescriptions, modeLabels, modeOrder } from './labels';
import { MAX_CSV_LENGTH, MAX_ROWS, IMPORT_ENTITIES, templateOf } from './rules';

export type { FormAlert };

/** The result of the last validation of the file in the form, and the failure reports of its rows. */
export interface ValidationResult {
  readonly job: ImportJob;
  /** `fileSignatureOf` the values it validated: another file makes it stale. */
  readonly fileSignature: string;
  readonly rows: ResourceState<{ readonly items: readonly ImportRow[]; readonly total: number }>;
}

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

function ValidationPanel({
  result,
  values,
  submitting,
  onConfirm,
  onRetryRows,
}: {
  result: ValidationResult;
  values: ImportFormValues;
  submitting: ImportMode | null;
  onConfirm: ImportFormProps['onConfirm'];
  onRetryRows: (() => void) | undefined;
}) {
  const { job } = result;
  const stale = result.fileSignature !== fileSignatureOf(values);
  if (stale)
    return (
      <Notifications
        messages={[
          {
            id: 'stale',
            text: 'Cambiaste el archivo después de validarlo. Valida de nuevo antes de importar.',
            severity: 'warning',
          },
        ]}
      />
    );
  const allValid = job.invalidRows === 0;
  return (
    <Box component="section" aria-labelledby="validation-title">
      <Typography id="validation-title" component="h2" variant="h2" sx={{ mb: 1 }}>
        Resultado de la validación
      </Typography>
      <Box
        component="dl"
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', sm: 'minmax(160px, 220px) 1fr' },
          columnGap: 3,
          m: 0,
          mb: 2,
        }}
      >
        {(
          [
            ['Filas revisadas', number(job.totalRows)],
            ['Filas válidas', number(job.validRows)],
            ['Filas con error', number(job.invalidRows)],
          ] as const
        ).map(([label, value]) => (
          <React.Fragment key={label}>
            <Typography component="dt" variant="body2" color="text.secondary">
              {label}
            </Typography>
            <Typography component="dd" variant="body1" sx={{ m: 0, mb: 0.5 }}>
              {value}
            </Typography>
          </React.Fragment>
        ))}
      </Box>
      {allValid ? (
        <Notifications
          messages={[
            {
              id: 'all-valid',
              text: 'Todas las filas son válidas. No se creó ningún registro todavía.',
              severity: 'success',
            },
          ]}
        />
      ) : (
        <>
          <Notifications
            messages={[
              {
                id: 'some-invalid',
                text: `${number(job.invalidRows)} filas tienen errores y no se importarán. No se creó ningún registro todavía.`,
                severity: 'warning',
              },
            ]}
          />
          {result.rows.status === 'ready' ? (
            <>
              <ImportRowsTable
                rows={result.rows.data.items}
                entity={values.entity}
                caption={`Filas con error (${result.rows.data.total})`}
                label="Tabla de filas con error"
              />
              {result.rows.data.total > result.rows.data.items.length && (
                <Typography variant="body2" sx={{ mb: 1 }}>
                  Se muestran las primeras {result.rows.data.items.length} filas.{' '}
                  <RouterLink
                    to={importPath(job.id)}
                    sx={{ color: 'primary.main', textDecoration: 'underline' }}
                  >
                    Ver el informe completo
                  </RouterLink>
                </Typography>
              )}
            </>
          ) : (
            <Box sx={{ my: 1 }}>
              {result.rows.status === 'error' ? (
                <UiState
                  kind="error"
                  title="No pudimos cargar el informe de errores"
                  actionLabel="Reintentar"
                  {...(onRetryRows ? { onAction: onRetryRows } : {})}
                />
              ) : (
                <UiState kind="loading" />
              )}
            </Box>
          )}
        </>
      )}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2 }}>
        <Button
          variant="contained"
          disabled={job.validRows === 0 || submitting !== null}
          loading={submitting === 'commit_valid'}
          onClick={() => onConfirm(values, 'commit_valid')}
        >
          {`Importar las ${number(job.validRows)} filas válidas`}
        </Button>
        <Button
          variant="outlined"
          disabled={!allValid || submitting !== null}
          loading={submitting === 'commit_all'}
          onClick={() => onConfirm(values, 'commit_all')}
        >
          Importar todo
        </Button>
      </Box>
      {!allValid && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          «Importar todo» se habilita cuando no queda ninguna fila con error. Corrige el archivo y
          valídalo de nuevo, o importa solo las válidas.
        </Typography>
      )}
    </Box>
  );
}

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
        {values.mode !== 'dry_run' && (
          <Notifications
            messages={[
              {
                id: 'commit-note',
                text: 'Este modo crea registros reales. Te recomendamos validar el archivo antes. Si reintentas por un fallo de conexión, la importación no se duplica.',
                severity: 'warning',
              },
            ]}
          />
        )}
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
          <ValidationPanel
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
