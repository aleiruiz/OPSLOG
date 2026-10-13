import ErrorOutline from '@mui/icons-material/ErrorOutline';
import ScheduleOutlined from '@mui/icons-material/ScheduleOutlined';
import Box from '@mui/material/Box';
import React from 'react';
import { StatCard } from '@opslog/ui';
import type { AlertSeverity } from '../app/types';
import type { AlertsSummaryData } from './AlertsSummary';

const days = (count: number) => `${count} ${count === 1 ? 'día' : 'días'}`;

/**
 * Totals by status at the top of the alerts screen. Each card also filters the list by its status;
 * `aria-pressed` tells which one is applied. Hidden when the totals could not be loaded (best effort).
 */
export function AlertStats({
  data,
  severity,
  onSelect,
}: {
  /** `undefined` while loading, `null` when the totals are not available. */
  data: AlertsSummaryData | null | undefined;
  severity: AlertSeverity | '';
  onSelect: (severity: AlertSeverity | '') => void;
}) {
  if (data === null) return null;
  const toggle = (value: AlertSeverity) => () => onSelect(severity === value ? '' : value);
  return (
    <Box
      component="section"
      aria-label="Resumen de vencimientos"
      sx={{
        display: 'grid',
        gridTemplateColumns: {
          xs: 'repeat(2, minmax(0, 1fr))',
          lg: 'repeat(2, minmax(0, 320px))',
        },
        gap: 2,
        mb: 3,
      }}
    >
      <StatCard
        label="Vencidos"
        value={data?.expired}
        hint="Requieren renovación"
        tone="danger"
        icon={<ErrorOutline fontSize="small" />}
        pressed={severity === 'expired'}
        onToggle={toggle('expired')}
      />
      <StatCard
        label="Por vencer"
        value={data?.expiring}
        hint={data ? `En los próximos ${days(data.windowDays)}` : ''}
        tone="warning"
        icon={<ScheduleOutlined fontSize="small" />}
        pressed={severity === 'expiring'}
        onToggle={toggle('expiring')}
      />
    </Box>
  );
}
