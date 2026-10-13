import ArrowBack from '@mui/icons-material/ArrowBack';
import Box from '@mui/material/Box';
import React from 'react';
import { RouterLink } from './router';

/** Link back to the list a detail screen belongs to, above the page header. */
export function BackLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mb: 1.5 }}>
      <RouterLink
        to={to}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          color: 'text.secondary',
          fontWeight: 500,
          '&:hover': { color: 'primary.main', textDecoration: 'underline' },
        }}
      >
        <ArrowBack aria-hidden="true" sx={{ fontSize: 18 }} />
        {children}
      </RouterLink>
    </Box>
  );
}
