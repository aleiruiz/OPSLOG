import Box from '@mui/material/Box';
import React from 'react';
import { statusColors } from '@opslog/ui';
import type { BffCountWidget } from '@opslog/contracts';
import { formatCount } from './format';
import { WIDGET_COPY } from './labels';
import { drilldownLinks } from './links';
import { Figure, WidgetFrame } from './WidgetFrame';

/** A count with its tone and, when it asks for attention, the words that say so. */
export function CountWidget({ widget }: { widget: BffCountWidget }) {
  const copy = WIDGET_COPY[widget.id];
  const flagged = copy.attention !== undefined && widget.value > 0;
  const tint = statusColors[flagged && copy.attention ? copy.attention.tone : 'neutral'];
  return (
    <WidgetFrame title={copy.title} note={copy.note} links={drilldownLinks(widget)}>
      <Figure
        value={formatCount(widget.value)}
        caption={widget.value === 0 && copy.attention ? 'Ninguno por ahora' : copy.hint}
        badge={
          flagged && copy.attention ? (
            <Box
              component="span"
              sx={{
                display: 'inline-block',
                mt: 0.5,
                px: 1,
                py: 0.25,
                borderRadius: 1,
                fontSize: 12,
                fontWeight: 600,
                color: tint.foreground,
                bgcolor: tint.background,
              }}
            >
              {copy.attention.text}
            </Box>
          ) : undefined
        }
      />
    </WidgetFrame>
  );
}
