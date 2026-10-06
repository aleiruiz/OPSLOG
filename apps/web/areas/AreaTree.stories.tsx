import React from 'react';
import type { ResourceState } from '../app/resource';
import type { ApiError } from '../app/types';
import { demoAreas } from './fixtures';
import { AreaTreeView, type AreaTreeData, type AreaTreeViewProps } from './AreaTreeView';
import { Frame, noop } from './storyFrame';
import { buildTree, defaultExpanded } from './tree';

export default {
  title: 'Plantilla/Areas/Arbol',
  parameters: { layout: 'padded' },
};

const all = demoAreas();
const active = all.filter((area) => area.active);
const ready = (areas = active, truncated = false): ResourceState<AreaTreeData> => ({
  status: 'ready',
  data: { areas, truncated },
});
const roots = (areas = active) => defaultExpanded(buildTree(areas));
const everything = (areas = active) =>
  new Set(areas.filter((a) => areas.some((c) => c.parentId === a.id)).map((a) => a.id));
const admin = () => true;
const readOnly = () => false;
const failure = (status: ApiError['status'], code: string): ApiError => ({
  code,
  status,
  message: 'x',
  correlationId: 'c',
});

const view = (props: Partial<AreaTreeViewProps> = {}) => (
  <Frame>
    <AreaTreeView
      state={ready()}
      includeInactive={false}
      can={admin}
      expanded={roots()}
      onToggle={noop}
      onExpandAll={noop}
      onCollapseAll={noop}
      onIncludeInactiveChange={noop}
      onOpen={noop}
      onRetry={noop}
      {...props}
    />
  </Frame>
);

export const Default = { render: () => view() };
export const AllExpanded = { render: () => view({ expanded: everything() }) };
export const Collapsed = { render: () => view({ expanded: new Set<string>() }) };
export const WithInactive = {
  render: () =>
    view({ state: ready(all), includeInactive: true, expanded: everything(all) }),
};
export const ReadOnly = { render: () => view({ can: readOnly }) };
export const Truncated = { render: () => view({ state: ready(active, true) }) };
export const Empty = { render: () => view({ state: ready([]) }) };
export const EmptyReadOnly = { render: () => view({ state: ready([]), can: readOnly }) };
export const Loading = { render: () => view({ state: { status: 'loading' } }) };
export const Error = {
  render: () => view({ state: { status: 'error', error: failure(500, 'internal_error') } }),
};
export const NoPermission = {
  render: () => view({ state: { status: 'forbidden' }, can: readOnly }),
};
export const SessionExpired = { render: () => view({ state: { status: 'expired' } }) };
