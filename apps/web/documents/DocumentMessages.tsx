import Box from '@mui/material/Box';
import React from 'react';
import { UiState } from '@opslog/ui';
import { RouterLink } from '../app/router';

const link = { color: 'primary.main', textDecoration: 'underline' } as const;
export const documentsPath = '/flota/documentos';
export const documentPath = (id: string) => `${documentsPath}/${encodeURIComponent(id)}`;

/** Unknown id, or an id of another company: the backend answers both with the same 404. */
export function DocumentNotFound() {
  return (
    <>
      <UiState
        kind="no-results"
        title="Documento no encontrado"
        description="Revisa la dirección o vuelve al listado."
      />
      <Box sx={{ mt: 2 }}>
        <RouterLink to={documentsPath} sx={link}>
          Volver a documentos
        </RouterLink>
      </Box>
    </>
  );
}

/** Archived documents are read-only; changing them explains why instead of showing a form. */
export function DocumentNotEditable({ documentId }: { documentId: string }) {
  return (
    <>
      <UiState
        kind="closed"
        title="Este documento no se puede cambiar"
        description="Está archivado: es un registro histórico de solo lectura."
      />
      <Box sx={{ mt: 2 }}>
        <RouterLink to={documentPath(documentId)} sx={link}>
          Volver al documento
        </RouterLink>
      </Box>
    </>
  );
}
