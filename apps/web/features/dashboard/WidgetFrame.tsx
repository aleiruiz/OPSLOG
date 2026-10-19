import ArrowForward from '@mui/icons-material/ArrowForward';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { opslogTokens } from '@opslog/ui';
import { linkSx, RouterLink } from '../../app/router';
import type { DrilldownLink } from './links';

const { colors, shape, shadow } = opslogTokens;

/** The card every widget lives in: a titled article, its figure, an optional note and the drill-down links. */
export function WidgetFrame({
  title,
  note,
  links,
  wide = false,
  children,
}: {
  title: string;
  note?: string | undefined;
  links: readonly DrilldownLink[];
  wide?: boolean;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <Box
      component="article"
      aria-labelledby={id}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        minWidth: 0,
        p: { xs: 2, sm: 2.5 },
        bgcolor: colors.surface,
        border: `1px solid ${colors.border}`,
        borderRadius: `${shape.cardRadius}px`,
        boxShadow: shadow.card,
        ...(wide ? { gridColumn: { sm: 'span 2' } } : {}),
      }}
    >
      <Typography id={id} component="h3" variant="body2" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      {children}
      {note && (
        <Typography variant="caption" color="text.secondary">
          {note}
        </Typography>
      )}
      {links.length > 0 && (
        <Box
          component="ul"
          sx={{ listStyle: 'none', m: 0, p: 0, mt: 'auto', pt: 1, display: 'grid', gap: 0.5 }}
        >
          {links.map((link) => (
            <li key={link.to}>
              <RouterLink to={link.to} label={`${link.label}: ${title}`} sx={linkSx}>
                {link.label}
                <ArrowForward
                  aria-hidden="true"
                  sx={{ fontSize: 14, ml: 0.5, verticalAlign: 'text-bottom' }}
                />
              </RouterLink>
            </li>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** A big figure with its caption. `attention` adds words next to the tone so color is never the only signal. */
export function Figure({
  value,
  caption,
  badge,
}: {
  value: string;
  caption: string;
  badge?: React.ReactNode;
}) {
  return (
    <Box>
      <Typography
        component="p"
        sx={{ m: 0, fontSize: 28, fontWeight: 600, lineHeight: 1.2, color: colors.text }}
      >
        {value}
      </Typography>
      <Typography component="p" variant="caption" color="text.secondary" sx={{ m: 0 }}>
        {caption}
      </Typography>
      {badge}
    </Box>
  );
}
