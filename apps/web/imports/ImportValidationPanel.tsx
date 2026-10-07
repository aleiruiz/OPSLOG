import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, UiState } from '@opslog/ui';
import type { ResourceState } from '../app/resource';
import { RouterLink } from '../app/router';
import type { ImportJob, ImportMode, ImportRow } from '../app/types';
import { fileSignatureOf, type ImportFormValues } from './formModel';
import { importPath } from './ImportMessages';
import { ImportRowsTable } from './ImportRowsTable';

/** The result of the last validation of the file in the form, and the failure reports of its rows. */
export interface ValidationResult {
  readonly job: ImportJob;
  /** `fileSignatureOf` the values it validated: another file makes it stale. */
  readonly fileSignature: string;
  readonly rows: ResourceState<{ readonly items: readonly ImportRow[]; readonly total: number }>;
}

const number = (value: number) => new Intl.NumberFormat('es-MX').format(value);

export function ImportValidationPanel({
  result,
  values,
  submitting,
  onConfirm,
  onRetryRows,
}: {
  result: ValidationResult;
  values: ImportFormValues;
  submitting: ImportMode | null;
  onConfirm: (values: ImportFormValues, mode: 'commit_valid' | 'commit_all') => void;
  onRetryRows: (() => void) | undefined;
}) {
  const { job } = result;
  const stale = result.fileSignature !== fileSignatureOf(values);
  if (stale)
    return (
      <Alert severity="warning" sx={{ mb: 2 }}>
        {'Cambiaste el archivo después de validarlo. Valida de nuevo antes de importar.'}
      </Alert>
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
        <Alert severity="success" sx={{ mb: 2 }}>
          {'Todas las filas son válidas. No se creó ningún registro todavía.'}
        </Alert>
      ) : (
        <>
          <Alert
            severity="warning"
            sx={{ mb: 2 }}
          >{`${number(job.invalidRows)} filas tienen errores y no se importarán. No se creó ningún registro todavía.`}</Alert>
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
