import Box from '@mui/material/Box';
import React from 'react';

/** Keeps wide tables inside the page at 360px: the table scrolls, the page does not. Keyboard focusable. */
export function ScrollRegion({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box role="region" aria-label={label} tabIndex={0} sx={{ overflowX: 'auto', mb: 2 }}>
      {children}
    </Box>
  );
}
