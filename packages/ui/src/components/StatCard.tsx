import React from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { opslogTokens, statusColors, type StatusTone } from '../tokens';

const { colors, shape, shadow } = opslogTokens;

/**
 * A total with its label and a short hint. With `onToggle` it is a toggle button (a quick filter) and
 * `pressed` tells whether it is applied; `value` undefined renders the loading placeholder.
 */
export function StatCard({
  label,
  value,
  hint,
  tone,
  icon,
  pressed = false,
  onToggle,
}: {
  label: string;
  value: number | undefined;
  hint: string;
  tone: StatusTone;
  icon?: React.ReactNode;
  pressed?: boolean;
  onToggle?: () => void;
}) {
  const tint = statusColors[tone];
  const body = (
    <>
      {icon && (
        <Box
          aria-hidden="true"
          sx={{
            display: { xs: 'none', sm: 'grid' },
            placeItems: 'center',
            width: 40,
            height: 40,
            flexShrink: 0,
            borderRadius: '10px',
            color: tint.foreground,
            bgcolor: tint.background,
          }}
        >
          {icon}
        </Box>
      )}
      <Box sx={{ minWidth: 0 }}>
        <Typography component="span" variant="body2" color="text.secondary" display="block">
          {label}
        </Typography>
        <Typography
          component="span"
          display="block"
          sx={{ fontSize: 28, fontWeight: 600, lineHeight: 1.2, color: colors.text }}
        >
          {value === undefined ? <Skeleton width={40} /> : value}
        </Typography>
        <Typography component="span" variant="caption" color="text.secondary" display="block">
          {value === undefined ? 'Cargando…' : hint}
        </Typography>
      </Box>
    </>
  );
  const sx = {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
    gap: 2,
    p: { xs: 2, sm: 2.5 },
    textAlign: 'left',
    bgcolor: colors.surface,
    border: `1px solid ${pressed ? tint.foreground : colors.border}`,
    outline: pressed ? `1px solid ${tint.foreground}` : 'none',
    borderRadius: `${shape.cardRadius}px`,
    boxShadow: shadow.card,
  } as const;
  return onToggle ? (
    <ButtonBase
      aria-pressed={pressed}
      disabled={value === undefined}
      onClick={onToggle}
      sx={{ ...sx, '&:hover': { borderColor: pressed ? tint.foreground : colors.borderStrong } }}
    >
      {body}
    </ButtonBase>
  ) : (
    <Box sx={sx}>{body}</Box>
  );
}
