import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { DescriptionList, Notifications, opslogTokens } from '@opslog/ui';
import { BackLink as BackTo } from '../app/BackLink';
import { employeesPath } from './EmployeeMessages';

export function Mono({ children }: { children: React.ReactNode }) {
  return (
    <Typography component="span" sx={{ fontFamily: opslogTokens.typography.monoFamily }}>
      {children}
    </Typography>
  );
}

export function BackLink() {
  return <BackTo to={employeesPath}>Volver a empleados</BackTo>;
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
  return <DescriptionList columns={3} items={rows.map(([label, value]) => ({ label, value }))} />;
}
