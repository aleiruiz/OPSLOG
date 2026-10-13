import LocalShippingOutlined from '@mui/icons-material/LocalShippingOutlined';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { opslogTokens } from '@opslog/ui';

const { colors, typography } = opslogTokens;

/** The OPSLOG logo: a truck tile and the product name (hidden on phones inside the shell). */
export function BrandMark({ compact = true }: { compact?: boolean }) {
  return (
    <>
      <Box
        aria-hidden="true"
        sx={{
          width: 28,
          height: 28,
          borderRadius: '8px',
          bgcolor: colors.primary,
          color: colors.surface,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <LocalShippingOutlined sx={{ fontSize: 18 }} />
      </Box>
      <Typography
        component="p"
        sx={{
          display: compact ? { xs: 'none', sm: 'block' } : 'block',
          fontFamily: typography.monoFamily,
          fontWeight: 600,
          fontSize: 16,
          letterSpacing: '0.04em',
        }}
      >
        OPSLOG
      </Typography>
    </>
  );
}
