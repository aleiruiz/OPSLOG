import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Notifications, opslogTokens } from '@opslog/ui';
import { RouterLink } from '../app/router';
import type { Area } from '../app/types';
import { areaPath, areasPath } from './AreaTreeView';

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
      <RouterLink to={areasPath} sx={linkSx}>
        Volver a áreas
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

export function Path({ chain }: { chain: readonly Area[] }) {
  if (chain.length === 0) return null;
  return (
    <Box component="nav" aria-label="Ruta del área" sx={{ mb: 2, typography: 'body2' }}>
      <Box
        component="ol"
        sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, listStyle: 'none', p: 0, m: 0 }}
      >
        {chain.map((area, index) => (
          <li key={area.id}>
            <RouterLink to={areaPath(area.id)} sx={linkSx}>
              {area.name}
            </RouterLink>
            {index < chain.length - 1 && <span aria-hidden="true"> ›</span>}
          </li>
        ))}
      </Box>
    </Box>
  );
}
