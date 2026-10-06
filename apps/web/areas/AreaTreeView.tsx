import Box from '@mui/material/Box';
import React from 'react';
import { Button, Field, FilterBar, Notifications, PageHeader, UiState } from '@opslog/ui';
import { NoSubmit, ResourceView, type ResourceState } from '../app/resource';
import { RouterButton } from '../app/router';
import type { Area } from '../app/types';
import { AreaTree } from './AreaTree';
import { count } from './labels';
import { allNodes, buildTree } from './tree';

export interface AreaTreeData {
  readonly areas: readonly Area[];
  readonly truncated: boolean;
}

export interface AreaTreeViewProps {
  readonly state: ResourceState<AreaTreeData>;
  readonly includeInactive: boolean;
  readonly can: (permission: 'create') => boolean;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (id: string, open: boolean) => void;
  readonly onExpandAll: (ids: readonly string[]) => void;
  readonly onCollapseAll: () => void;
  readonly onIncludeInactiveChange: (include: boolean) => void;
  readonly onOpen: (id: string) => void;
  readonly onRetry: () => void;
}

export const areasPath = '/plantilla/areas';
export const areaPath = (id: string) => `${areasPath}/${encodeURIComponent(id)}`;

/** Area tree: filter, expand/collapse controls, the tree itself and every data state (SPECS §8). */
export function AreaTreeView({
  state,
  includeInactive,
  can,
  expanded,
  onToggle,
  onExpandAll,
  onCollapseAll,
  onIncludeInactiveChange,
  onOpen,
  onRetry,
}: AreaTreeViewProps) {
  const uid = React.useId();
  return (
    <>
      <PageHeader
        title="Áreas"
        description="Estructura organizativa de tu empresa: hasta cuatro niveles, con responsables."
        actions={
          can('create') ? (
            <RouterButton to={`${areasPath}/nueva`} variant="contained">
              Nueva área
            </RouterButton>
          ) : undefined
        }
      />
      <NoSubmit>
        <FilterBar>
          <Field
            id={`${uid}-inactive`}
            label="Estado"
            select
            SelectProps={{ native: true }}
            InputLabelProps={{ shrink: true }}
            value={includeInactive ? 'true' : 'false'}
            onChange={(event) => onIncludeInactiveChange(event.target.value === 'true')}
          >
            <option value="false">Solo áreas activas</option>
            <option value="true">Incluir áreas inactivas</option>
          </Field>
        </FilterBar>
      </NoSubmit>
      <ResourceView state={state} onRetry={onRetry}>
        {(data) => {
          if (data.areas.length === 0)
            return (
              <UiState
                kind="empty"
                title="Aún no hay áreas"
                description={
                  can('create')
                    ? 'Crea la primera área para organizar tu flota y tu plantilla.'
                    : 'Cuando se creen áreas aparecerán aquí.'
                }
              />
            );
          const roots = buildTree(data.areas);
          const branches = allNodes(roots)
            .filter((node) => node.children.length > 0)
            .map((node) => node.area.id);
          return (
            <>
              {data.truncated && (
                <Box sx={{ mb: 2 }}>
                  <Notifications
                    messages={[
                      {
                        id: 'truncated',
                        severity: 'warning',
                        text: `Se muestran las primeras ${data.areas.length} áreas; la estructura puede estar incompleta.`,
                      },
                    ]}
                  />
                </Box>
              )}
              <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 1 }}>
                <Button variant="outlined" size="small" onClick={() => onExpandAll(branches)}>
                  Expandir todo
                </Button>
                <Button variant="outlined" size="small" onClick={onCollapseAll}>
                  Contraer todo
                </Button>
                <Box component="span" sx={{ color: 'text.secondary', typography: 'body2' }}>
                  {count(data.areas.length, 'área', 'áreas')}
                </Box>
              </Box>
              <Box component="p" sx={{ color: 'text.secondary', typography: 'body2', mt: 0, mb: 1 }}>
                Con el teclado: flechas arriba y abajo para moverte, derecha e izquierda para abrir o
                cerrar una rama, Enter para abrir el área.
              </Box>
              <AreaTree roots={roots} expanded={expanded} onToggle={onToggle} onOpen={onOpen} />
            </>
          );
        }}
      </ResourceView>
    </>
  );
}
