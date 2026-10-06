import React from 'react';
import { useResource } from '../app/resource';
import { useRouter } from '../app/router';
import { useSession } from '../auth/session';
import { areaPath, AreaTreeView } from './AreaTreeView';
import { loadAllAreas } from './loadAreas';
import { buildTree, defaultExpanded } from './tree';

/** Area tree screen. Requires `view`; "Nueva área" depends on `create`. */
export function AreasScreen() {
  const { ports, can } = useSession();
  const router = useRouter();
  const [includeInactive, setIncludeInactive] = React.useState(false);
  const { state, reload } = useResource(
    () => loadAllAreas(ports.areas, includeInactive),
    [ports, includeInactive],
  );
  const [expanded, setExpanded] = React.useState<ReadonlySet<string> | null>(null);

  // Until the person opens or closes something, the roots are open (first two levels visible).
  const open =
    expanded ??
    (state.status === 'ready' ? defaultExpanded(buildTree(state.data.areas)) : new Set<string>());
  const toggle = (id: string, isOpen: boolean) => {
    const next = new Set(open);
    if (isOpen) next.add(id);
    else next.delete(id);
    setExpanded(next);
  };

  return (
    <AreaTreeView
      state={state}
      includeInactive={includeInactive}
      can={can}
      expanded={open}
      onToggle={toggle}
      onExpandAll={(ids) => setExpanded(new Set(ids))}
      onCollapseAll={() => setExpanded(new Set())}
      onIncludeInactiveChange={setIncludeInactive}
      onOpen={(id) => router.navigate(areaPath(id))}
      onRetry={reload}
    />
  );
}
