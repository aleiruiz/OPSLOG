import Box from '@mui/material/Box';
import React from 'react';
import { Panel } from '@opslog/ui';
import { BrandMark } from '../app/BrandMark';

/** Public screens (sign-in, invitation): the logo above one centred card on the page background. */
export function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: { sm: 'center' },
        px: 2,
        py: { xs: 4, sm: 6 },
        bgcolor: 'background.default',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
        <BrandMark compact={false} />
      </Box>
      <Box sx={{ width: '100%', maxWidth: 440, '& > *': { mb: 0 } }}>
        <Panel>{children}</Panel>
      </Box>
    </Box>
  );
}
