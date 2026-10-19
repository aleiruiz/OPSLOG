import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { BffDurationWidget, BffMoneyWidget } from '@opslog/contracts';
import { formatCount, formatDays, formatMoney } from './format';
import { WIDGET_COPY } from './labels';
import { drilldownLinks, widgetNote } from './links';
import { Figure, WidgetFrame } from './WidgetFrame';

/** Median and p90 of the days to resolve; «Sin datos» when no case was resolved in the range. */
export function DurationWidget({ widget }: { widget: BffDurationWidget }) {
  const copy = WIDGET_COPY[widget.id];
  return (
    <WidgetFrame
      title={copy.title}
      note={widgetNote(widget, copy.note)}
      links={drilldownLinks(widget)}
    >
      <Figure value={formatDays(widget.medianDays)} caption="Mediana" />
      {widget.count > 0 ? (
        <Typography variant="body2">
          {`p90: ${formatDays(widget.p90Days)} · ${formatCount(widget.count)} ${widget.count === 1 ? 'caso resuelto' : 'casos resueltos'}`}
        </Typography>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Ningún caso se resolvió en el periodo.
        </Typography>
      )}
    </WidgetFrame>
  );
}

/** One total per currency; different currencies are listed, never added together. */
export function MoneyWidget({ widget }: { widget: BffMoneyWidget }) {
  const copy = WIDGET_COPY[widget.id];
  return (
    <WidgetFrame
      title={copy.title}
      note={widgetNote(widget, copy.note)}
      links={drilldownLinks(widget)}
    >
      {widget.byCurrency.length === 0 ? (
        <Figure value="Sin datos" caption={copy.hint} />
      ) : (
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {widget.byCurrency.map((total) => (
            <Typography
              key={total.currency}
              component="li"
              sx={{ fontSize: 20, fontWeight: 600, lineHeight: 1.4 }}
            >
              {formatMoney(total.amountMinor, total.currency)}
            </Typography>
          ))}
        </Box>
      )}
      <Typography variant="body2" color="text.secondary">
        {`${formatCount(widget.orders)} ${widget.orders === 1 ? 'orden cerrada' : 'órdenes cerradas'}`}
        {widget.byCurrency.length > 1 ? '; las monedas no se suman.' : '.'}
      </Typography>
    </WidgetFrame>
  );
}
