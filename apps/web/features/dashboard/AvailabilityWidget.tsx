import Typography from '@mui/material/Typography';
import React from 'react';
import { opslogTokens } from '@opslog/ui';
import type { BffAvailabilityWidget } from '@opslog/contracts';
import { formatDay } from '../incidents/time';
import { DataDetails } from './DataDetails';
import { formatCount, formatPercent } from './format';
import { WIDGET_COPY } from './labels';
import { drilldownLinks, widgetNote } from './links';
import { Figure, WidgetFrame } from './WidgetFrame';

const { colors } = opslogTokens;
const WIDTH = 300;
const HEIGHT = 64;

const dayPercent = (day: { available: number; live: number }): number | null =>
  day.live === 0 ? null : Math.round((1000 * day.available) / day.live) / 10;

/** Average availability of the range and one bar per day (a day without vehicles has no bar). */
export function AvailabilityWidget({ widget }: { widget: BffAvailabilityWidget }) {
  const copy = WIDGET_COPY[widget.id];
  const known = widget.series.flatMap((day) => {
    const percent = dayPercent(day);
    return percent === null ? [] : [percent];
  });
  const lowest = known.length > 0 ? Math.min(...known) : null;
  const slot = WIDTH / Math.max(1, widget.series.length);
  const summary =
    widget.percent === null
      ? 'Sin datos de flota en el periodo.'
      : `Promedio ${formatPercent(widget.percent)} en ${formatCount(widget.days)} ${widget.days === 1 ? 'día' : 'días'}; el día más bajo fue ${formatPercent(lowest)}.`;
  return (
    <WidgetFrame
      title={copy.title}
      note={widgetNote(widget, copy.note)}
      links={drilldownLinks(widget)}
      wide
    >
      <Figure value={formatPercent(widget.percent)} caption={copy.hint} />
      {widget.percent !== null && (
        <>
          <svg
            role="img"
            aria-label={`Disponibilidad diaria. ${summary}`}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            style={{ width: '100%', maxWidth: 480, height: 'auto' }}
          >
            <line x1="0" x2={WIDTH} y1={HEIGHT} y2={HEIGHT} stroke={colors.borderStrong} />
            {widget.series.map((day, index) => {
              const percent = dayPercent(day);
              if (percent === null) return null;
              const height = (percent / 100) * (HEIGHT - 2);
              return (
                <rect
                  key={day.day}
                  x={index * slot}
                  y={HEIGHT - height}
                  width={Math.max(0.5, slot * 0.8)}
                  height={height}
                  fill={colors.primary}
                />
              );
            })}
          </svg>
          <Typography variant="caption" color="text.secondary">
            {summary}
          </Typography>
          <DataDetails
            summary="Ver disponibilidad por día"
            caption="Disponibilidad por día"
            head={['Día', 'Disponibles', 'Vehículos', 'Disponibilidad']}
            rows={widget.series.map((day) => [
              formatDay(day.day),
              formatCount(day.available),
              formatCount(day.live),
              formatPercent(dayPercent(day)),
            ])}
          />
        </>
      )}
    </WidgetFrame>
  );
}
