import type { ViewCatalog, ViewModuleCatalog } from './ports.js';
import type { ViewViewer } from './types.js';

const maintenance: ViewModuleCatalog = {
  access: 'view',
  filters: new Map([
    ['status', { label: 'Estado', accepts: (v: string) => ['open', 'closed'].includes(v) }],
    [
      'costFrom',
      { label: 'Costo desde', permission: 'view_costs', accepts: (v: string) => /^\d+$/.test(v) },
    ],
  ]),
  sorts: new Set(['folio']),
  columns: new Map([
    ['folio', { label: 'Folio', locked: true }],
    ['status', { label: 'Estado', locked: false }],
    ['cost', { label: 'Costo', locked: false, permission: 'view_costs' }],
  ]),
};
const secret: ViewModuleCatalog = { ...maintenance, access: 'incidents:view' };

export const catalog: ViewCatalog = {
  module: (name) => (name === 'maintenance' ? maintenance : name === 'incidents' ? secret : null),
};

export const viewer = (memberId: string, ...permissions: string[]): ViewViewer => ({
  memberId,
  permissions: new Set(['view', ...permissions]),
});
