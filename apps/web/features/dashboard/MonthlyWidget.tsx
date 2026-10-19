import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { opslogTokens } from '@opslog/ui';
import type { BffMonthlyWidget } from '@opslog/contracts';
import { DataDetails } from './DataDetails';
import { formatCount, formatMonth } from './format';
import { WIDGET_COPY } from './labels';
import { drilldownLinks, widgetNote } from './links';
import { Figure, WidgetFrame } from './WidgetFrame';

const { colors } = opslogTokens;
const WIDTH = 300;
const HEIGHT = 110;
const BASE = 94;

/** Reported (solid) and closed (outlined) cases per month; legend, totals and a table say the same in text. */
export function MonthlyWidget({ widget }: { widget: BffMonthlyWidget }) {
  const copy = WIDGET_COPY[widget.id];
  const peak = Math.max(1, ...widget.months.flatMap((m) => [m.reported, m.closed]));
  const slot = WIDTH / Math.max(1, widget.months.length);
  const bar = Math.min(18, slot * 0.4);
  const scale = (value: number) => (value / peak) * (BASE - 8);
  const empty = widget.reported === 0 && widget.closed === 0;
  const summary = empty
    ? 'Sin siniestros reportados ni cerrados en el periodo.'
    : `${formatCount(widget.reported)} reportados y ${formatCount(widget.closed)} cerrados en el periodo.`;
  return (
    <WidgetFrame
      title={copy.title}
      note={widgetNote(widget, copy.note)}
      links={drilldownLinks(widget)}
      wide
    >
      <Figure
        value={`${formatCount(widget.reported)} / ${formatCount(widget.closed)}`}
        caption="Reportados / cerrados"
      />
      {!empty && (
        <>
          <svg
            role="img"
            aria-label={`Siniestros por mes. ${summary} El mes con más movimiento tiene ${formatCount(peak)}.`}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            style={{ width: '100%', maxWidth: 480, height: 'auto' }}
          >
            <line x1="0" x2={WIDTH} y1={BASE} y2={BASE} stroke={colors.borderStrong} />
            {widget.months.map((month, index) => {
              const x = index * slot + slot / 2;
              return (
                <g key={month.month}>
                  <rect
                    x={x - bar - 1}
                    y={BASE - scale(month.reported)}
                    width={bar}
                    height={scale(month.reported)}
                    fill={colors.primary}
                  />
                  <rect
                    x={x + 1}
                    y={BASE - scale(month.closed)}
                    width={bar}
                    height={scale(month.closed)}
                    fill={colors.surface}
                    stroke={colors.text}
                    strokeWidth="1.5"
                  />
                  {(widget.months.length <= 7 || index % 2 === 0) && (
                    <text
                      x={x}
                      y={BASE + 12}
                      textAnchor="middle"
                      fontSize="9"
                      fill={colors.textSecondary}
                    >
                      {formatMonth(month.month).slice(0, 3)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          <Box sx={{ display: 'flex', gap: 2, fontSize: 12, color: 'text.secondary' }}>
            <span>
              <Box
                component="span"
                aria-hidden="true"
                sx={{
                  display: 'inline-block',
                  width: 10,
                  height: 10,
                  bgcolor: colors.primary,
                  mr: 0.5,
                }}
              />
              Reportados
            </span>
            <span>
              <Box
                component="span"
                aria-hidden="true"
                sx={{
                  display: 'inline-block',
                  width: 10,
                  height: 10,
                  border: `1.5px solid ${colors.text}`,
                  mr: 0.5,
                }}
              />
              Cerrados
            </span>
          </Box>
          <Typography variant="caption" color="text.secondary">
            {summary}
          </Typography>
          <DataDetails
            summary="Ver siniestros por mes"
            caption="Siniestros reportados y cerrados por mes"
            head={['Mes', 'Reportados', 'Cerrados']}
            rows={widget.months.map((m) => [
              formatMonth(m.month),
              formatCount(m.reported),
              formatCount(m.closed),
            ])}
          />
        </>
      )}
      {empty && (
        <Typography variant="body2" color="text.secondary">
          {summary}
        </Typography>
      )}
    </WidgetFrame>
  );
}
