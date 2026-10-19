import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { opslogTokens } from '@opslog/ui';
import type { BffRatioWidget } from '@opslog/contracts';
import { formatCount, formatPercent } from './format';
import { WIDGET_COPY } from './labels';
import { drilldownLinks, widgetNote } from './links';
import { Figure, WidgetFrame } from './WidgetFrame';

const { colors } = opslogTokens;
const SUBJECTS = { vehicle: 'Vehículos', driver: 'Conductores' } as const;

/** A percentage with its bar, its numerator and denominator, and «Sin datos» when the denominator is 0. */
export function RatioWidget({ widget }: { widget: BffRatioWidget }) {
  const copy = WIDGET_COPY[widget.id];
  const text =
    widget.percent === null
      ? 'Sin registros que medir en este momento.'
      : `${formatCount(widget.numerator)} de ${formatCount(widget.denominator)}`;
  return (
    <WidgetFrame
      title={copy.title}
      note={widgetNote(widget, copy.note)}
      links={drilldownLinks(widget)}
    >
      <Figure value={formatPercent(widget.percent)} caption={copy.hint} />
      {widget.percent !== null && (
        <Box
          role="img"
          aria-label={`${formatPercent(widget.percent)}: ${text}`}
          sx={{ height: 8, borderRadius: 4, bgcolor: colors.border, overflow: 'hidden' }}
        >
          <Box sx={{ width: `${widget.percent}%`, height: '100%', bgcolor: colors.primary }} />
        </Box>
      )}
      <Typography variant="body2">{text}</Typography>
      {widget.parts.length > 0 && widget.percent !== null && (
        <Box component="ul" sx={{ m: 0, pl: 2, color: 'text.secondary', fontSize: 12 }}>
          {widget.parts.map((part) => (
            <li key={part.subject}>
              {`${SUBJECTS[part.subject]}: ${formatCount(part.numerator)} de ${formatCount(part.denominator)}`}
            </li>
          ))}
        </Box>
      )}
      {widget.excluded > 0 && (
        <Typography variant="caption" color="text.secondary">
          {`${formatCount(widget.excluded)} sin datos suficientes, fuera del cálculo.`}
        </Typography>
      )}
    </WidgetFrame>
  );
}
