import { opslogTokens } from '@opslog/ui';

const { colors, shape, shadow } = opslogTokens;

/** A create/edit form drawn as one card: its sections stacked inside, actions at the bottom. */
export const formCardSx = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  maxWidth: 760,
  bgcolor: colors.surface,
  border: `1px solid ${colors.border}`,
  borderRadius: `${shape.cardRadius}px`,
  boxShadow: shadow.card,
  p: { xs: 2, sm: 3 },
} as const;
