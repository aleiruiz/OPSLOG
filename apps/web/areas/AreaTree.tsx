import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { opslogTokens, StatusBadge } from '@opslog/ui';
import { count } from './labels';
import { visibleIds, type AreaNode } from './tree';

export interface AreaTreeProps {
  readonly roots: readonly AreaNode[];
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (id: string, open: boolean) => void;
  readonly onOpen: (id: string) => void;
  readonly label?: string;
}

const { colors } = opslogTokens;

/**
 * Tree of areas with the WAI-ARIA tree pattern: one tab stop (roving tabindex); Up/Down move between visible
 * items, Right opens a closed item or moves to its first child, Left closes an open item or moves to its parent,
 * Home/End go to the first/last visible item and Enter or Space opens the area. Clicking the arrow opens or closes
 * a branch; clicking the row opens the area.
 */
export function AreaTree({
  roots,
  expanded,
  onToggle,
  onOpen,
  label = 'Estructura de áreas',
}: AreaTreeProps) {
  const uid = React.useId();
  const items = React.useRef(new Map<string, HTMLElement>());
  const [focused, setFocused] = React.useState<string | null>(null);
  const visible = visibleIds(roots, expanded);
  // The remembered item may have been filtered out or hidden by a collapse: fall back to the first one.
  const tabStop = focused !== null && visible.includes(focused) ? focused : (visible[0] ?? null);

  const parents = React.useMemo(() => {
    const map = new Map<string, string>();
    const walk = (nodes: readonly AreaNode[], parent: string | null) => {
      for (const node of nodes) {
        if (parent) map.set(node.area.id, parent);
        walk(node.children, node.area.id);
      }
    };
    walk(roots, null);
    return map;
  }, [roots]);
  const hasChildren = React.useMemo(() => {
    const set = new Set<string>();
    const walk = (nodes: readonly AreaNode[]) => {
      for (const node of nodes) {
        if (node.children.length > 0) set.add(node.area.id);
        walk(node.children);
      }
    };
    walk(roots);
    return set;
  }, [roots]);

  const focusItem = (id: string | undefined) => {
    if (id === undefined) return;
    setFocused(id);
    items.current.get(id)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    // Only the item that holds focus reacts: keys typed in a nested control are not tree navigation.
    if (
      target.getAttribute('role') !== 'treeitem' ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    const id = target.dataset['areaId'] as string;
    const index = visible.indexOf(id);
    const open = expanded.has(id);
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        focusItem(visible[index + 1]);
        break;
      case 'ArrowUp':
        focusItem(visible[index - 1]);
        break;
      case 'Home':
        focusItem(visible[0]);
        break;
      case 'End':
        focusItem(visible[visible.length - 1]);
        break;
      case 'ArrowRight':
        if (!hasChildren.has(id)) break;
        if (!open) onToggle(id, true);
        else focusItem(visible[index + 1]);
        break;
      case 'ArrowLeft':
        if (open && hasChildren.has(id)) onToggle(id, false);
        else focusItem(parents.get(id));
        break;
      case 'Enter':
      case ' ':
        onOpen(id);
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  const renderLevel = (nodes: readonly AreaNode[], level: number): React.ReactNode =>
    nodes.map((node, position) => {
      const { area } = node;
      const branch = node.children.length > 0;
      const open = expanded.has(area.id);
      const labelId = `${uid}-${area.id}`;
      const stateId = `${uid}-${area.id}-state`;
      return (
        <Box
          component="li"
          key={area.id}
          role="treeitem"
          data-area-id={area.id}
          aria-labelledby={area.active ? labelId : `${labelId} ${stateId}`}
          aria-level={level}
          aria-setsize={nodes.length}
          aria-posinset={position + 1}
          {...(branch ? { 'aria-expanded': open } : {})}
          tabIndex={area.id === tabStop ? 0 : -1}
          ref={(element: HTMLElement | null) => {
            if (element) items.current.set(area.id, element);
            else items.current.delete(area.id);
          }}
          onFocus={(event: React.FocusEvent<HTMLElement>) => {
            if (event.target === event.currentTarget) setFocused(area.id);
          }}
          sx={{
            listStyle: 'none',
            outline: 'none',
            '&:focus-visible > .area-row': {
              outline: `2px solid ${colors.primary}`,
              outlineOffset: '-2px',
            },
          }}
        >
          <Box
            className="area-row"
            onClick={() => {
              setFocused(area.id);
              onOpen(area.id);
            }}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              minHeight: opslogTokens.layout.rowHeight,
              py: 0.5,
              pr: 1,
              borderRadius: `${opslogTokens.shape.controlRadius}px`,
              cursor: 'pointer',
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            <Box
              aria-hidden="true"
              onClick={(event: React.MouseEvent) => {
                if (!branch) return;
                event.stopPropagation();
                onToggle(area.id, !open);
              }}
              sx={{
                width: 28,
                height: 28,
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'text.secondary',
                borderRadius: '50%',
                fontSize: 12,
                '&:hover': branch ? { bgcolor: 'action.selected' } : undefined,
              }}
            >
              {branch ? (open ? '▾' : '▸') : ''}
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 1 }}>
                <Typography
                  id={labelId}
                  component="span"
                  variant="body1"
                  sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}
                >
                  {area.name}
                </Typography>
                {area.code && (
                  <Typography
                    component="span"
                    variant="body2"
                    sx={{ fontFamily: opslogTokens.typography.monoFamily, color: 'text.secondary' }}
                  >
                    {area.code}
                  </Typography>
                )}
                {!area.active && (
                  <Box component="span" id={stateId} sx={{ display: 'inline-flex' }}>
                    <StatusBadge label="Inactiva" tone="neutral" />
                  </Box>
                )}
              </Box>
              <Typography variant="body2" color="text.secondary">
                {count(node.children.length, 'sub-área', 'sub-áreas')} ·{' '}
                {count(area.responsibleIds.length, 'responsable', 'responsables')}
              </Typography>
            </Box>
          </Box>
          {branch && open && (
            <Box
              component="ul"
              role="group"
              sx={{ m: 0, p: 0, ml: 1.75, pl: 1.25, borderLeft: `1px solid ${colors.border}` }}
            >
              {renderLevel(node.children, level + 1)}
            </Box>
          )}
        </Box>
      );
    });

  return (
    <Box
      component="ul"
      role="tree"
      aria-label={label}
      onKeyDown={onKeyDown}
      sx={{ m: 0, p: 0, maxWidth: 880 }}
    >
      {renderLevel(roots, 1)}
    </Box>
  );
}
