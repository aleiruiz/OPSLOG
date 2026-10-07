import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Button, Notifications } from '@opslog/ui';
import type { EmployeeDetail } from '../app/types';
import { Mono, Rows } from './EmployeeDetailShared';
import { idTypeLabel } from './labels';

const MASK = '••••••••';

function Masked() {
  return (
    <>
      <span aria-hidden="true">{MASK}</span>
      <Box component="span" className="sr-only">
        Oculto
      </Box>
    </>
  );
}

const notOnFile = (
  <Typography component="span" color="text.secondary">
    No registrado
  </Typography>
);

/**
 * Personal data. A session without `view_pii` gets a masked placeholder (the server sends `pii: null`). A session
 * with it keeps the values hidden until the person asks to see them: the server already audited the disclosure
 * when it sent the data, and showing them is a deliberate action, not something that happens by opening the page.
 */
export function PersonalData({
  employee,
  canView,
  initiallyRevealed,
}: {
  employee: EmployeeDetail;
  canView: boolean;
  initiallyRevealed: boolean;
}) {
  const [revealed, setRevealed] = React.useState(initiallyRevealed);
  const rowsId = React.useId();
  const { piiPresent } = employee;
  const pii = canView ? employee.pii : null;
  const driver = employee.kind === 'driver';
  const entries: [string, boolean, React.ReactNode][] = pii
    ? [
        [
          'Identificación',
          pii.nationalId !== null,
          pii.nationalId !== null && (
            <Mono>
              {employee.idType ? `${idTypeLabel(employee.idType)} · ` : ''}
              {pii.nationalId}
            </Mono>
          ),
        ],
        ['Teléfono', pii.phone !== null, pii.phone && <Mono>{pii.phone}</Mono>],
        ['Correo electrónico', pii.email !== null, pii.email],
        ...(driver
          ? ([
              [
                'Número de licencia',
                pii.licenseNumber !== null,
                pii.licenseNumber && <Mono>{pii.licenseNumber}</Mono>,
              ],
            ] as [string, boolean, React.ReactNode][])
          : []),
      ]
    : [
        ['Identificación', piiPresent.nationalId, null],
        ['Teléfono', piiPresent.phone, null],
        ['Correo electrónico', piiPresent.email, null],
        ...(driver
          ? ([['Número de licencia', piiPresent.licenseNumber, null]] as [
              string,
              boolean,
              React.ReactNode,
            ][])
          : []),
      ];
  const rows = entries.map(([label, present, value]) => {
    let shown: React.ReactNode;
    if (!present) shown = notOnFile;
    else if (pii && revealed) shown = value;
    else shown = <Masked />;
    return [label, shown] as const;
  });
  return (
    <Box component="section" aria-labelledby="pii-title" sx={{ mt: 4 }}>
      <Typography id="pii-title" component="h2" variant="h2" sx={{ mb: 1 }}>
        Datos personales
      </Typography>
      {pii ? (
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          {revealed
            ? 'Los datos personales están visibles. Ocúltalos cuando termines; el acceso a ellos queda registrado en la auditoría.'
            : 'Los datos personales están ocultos en pantalla hasta que decidas mostrarlos. El acceso a ellos queda registrado en la auditoría.'}
        </Typography>
      ) : (
        <Box sx={{ mb: 2 }}>
          <Notifications
            messages={[
              {
                id: 'pii-protected',
                severity: 'info',
                text: 'Datos personales protegidos: tu rol no incluye el permiso para verlos. Aquí solo ves cuáles están registrados.',
              },
            ]}
          />
        </Box>
      )}
      <Box id={rowsId}>
        <Rows rows={rows} />
      </Box>
      {pii && (
        <Box sx={{ mt: 2 }}>
          <Button
            variant="outlined"
            aria-pressed={revealed}
            aria-controls={rowsId}
            onClick={() => setRevealed((value) => !value)}
          >
            {revealed ? 'Ocultar datos personales' : 'Mostrar datos personales'}
          </Button>
        </Box>
      )}
    </Box>
  );
}
