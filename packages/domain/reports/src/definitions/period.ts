import { APPLIED } from '../rows.js';
import type { ReportFilter } from '../types.js';

/** Period bounds the loaders of aggregating reports apply to their facts before grouping. */
export const FROM: ReportFilter = { id: 'from', label: 'Desde', kind: 'date', test: APPLIED };
export const TO: ReportFilter = { id: 'to', label: 'Hasta', kind: 'date', test: APPLIED };

export const AREA: ReportFilter = {
  id: 'areaId',
  label: 'Área',
  kind: 'id',
  test: (row, value) => row['_areaId'] === value,
};
