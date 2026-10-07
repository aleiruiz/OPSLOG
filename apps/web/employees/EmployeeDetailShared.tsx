import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Notifications, opslogTokens } from '@opslog/ui';
import { RouterLink } from '../app/router';
import { employeesPath } from './EmployeeMessages';

export const linkSx = { color: 'primary.main', textDecoration: 'underline' } as const;
export function Mono({ children }: { children: React.ReactNode }) {
  return (
    <Typography component="span" sx={{ fontFamily: opslogTokens.typography.monoFamily }}>
      {children}
    </Typography>
  );
}

export function BackLink() {
  return (
    <Box sx={{ mb: 2 }}>
      <RouterLink to={employeesPath} sx={linkSx}>
        Volver a empleados
      </RouterLink>
    </Box>
  );
}

/** Success message of the last change; kept focusable so the result is announced and reachable. */
export function FocusNotice({ text }: { text: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => ref.current?.focus(), [text]);
  return (
    <Box ref={ref} tabIndex={-1} sx={{ outline: 'none', mb: 2 }}>
      <Notifications messages={[{ id: 'notice', text, severity: 'success' }]} />
    </Box>
  );
}

export function Rows({ rows }: { rows: readonly (readonly [string, React.ReactNode])[] }) {
  return (
    <Box
      component="dl"
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', sm: 'minmax(160px, 220px) 1fr' },
        columnGap: 3,
        rowGap: { xs: 0.5, sm: 1.5 },
        m: 0,
        maxWidth: 720,
      }}
    >
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <Typography component="dt" variant="body2" color="text.secondary">
            {label}
          </Typography>
          <Typography
            component="dd"
            variant="body1"
            sx={{ m: 0, mb: { xs: 1.5, sm: 0 }, overflowWrap: 'anywhere' }}
          >
            {value}
          </Typography>
        </React.Fragment>
      ))}
    </Box>
  );
}
