import React from 'react';
import type { BffDashboardWidget } from '@opslog/contracts';
import { AvailabilityWidget } from './AvailabilityWidget';
import { CountWidget } from './CountWidget';
import { DurationWidget, MoneyWidget } from './MeasureWidgets';
import { MonthlyWidget } from './MonthlyWidget';
import { RatioWidget } from './RatioWidget';

/** One widget by its kind. */
export function WidgetView({ widget }: { widget: BffDashboardWidget }) {
  switch (widget.kind) {
    case 'count':
      return <CountWidget widget={widget} />;
    case 'ratio':
      return <RatioWidget widget={widget} />;
    case 'availability':
      return <AvailabilityWidget widget={widget} />;
    case 'monthly':
      return <MonthlyWidget widget={widget} />;
    case 'duration':
      return <DurationWidget widget={widget} />;
    case 'money':
      return <MoneyWidget widget={widget} />;
  }
}

/** True when the widget has nothing to show: no records, or a denominator of 0. */
export function isEmptyWidget(widget: BffDashboardWidget): boolean {
  switch (widget.kind) {
    case 'count':
      return widget.value === 0;
    case 'ratio':
      return widget.denominator === 0;
    case 'availability':
      return widget.percent === null;
    case 'monthly':
      return widget.reported === 0 && widget.closed === 0;
    case 'duration':
      return widget.count === 0;
    case 'money':
      return widget.orders === 0;
  }
}
