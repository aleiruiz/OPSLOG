import Typography from '@mui/material/Typography';
import React from 'react';
import { UiState } from '@opslog/ui';
import { RouterLink, useRouter } from '../../app/router';
import { useSession } from '../../auth/session';
import { searchCopy, searchTypeLabels } from './labels';
import { totalHits, useSearch } from './useSearch';

/** `/buscar?q=`: every hit of every type the reader may see (the box only shows the first ones). */
export function SearchScreen() {
  const { ports, markExpired } = useSession();
  const q = useRouter().search.get('q') ?? '';
  const state = useSearch(ports.search, q, markExpired, 0);
  return (
    <>
      <Typography variant="h1" component="h1">
        {searchCopy.title}
      </Typography>
      {state.status === 'idle' && <UiState kind="empty" title={searchCopy.hint} />}
      {state.status === 'loading' && <UiState kind="loading" title={searchCopy.loading} />}
      {state.status === 'error' && <UiState kind="error" title={searchCopy.error} />}
      {state.status === 'ready' && totalHits(state.result) === 0 && (
        <UiState kind="empty" title={searchCopy.empty} />
      )}
      {state.status === 'ready' &&
        state.result.groups
          .filter((group) => group.items.length > 0)
          .map((group) => (
            <section key={group.type} aria-labelledby={`resultados-${group.type}`}>
              <Typography variant="h2" component="h2" id={`resultados-${group.type}`}>
                {searchTypeLabels[group.type]} ({group.total})
              </Typography>
              <ul>
                {group.items.map((item) => (
                  <li key={item.id}>
                    <RouterLink to={item.href}>{item.label}</RouterLink>
                  </li>
                ))}
              </ul>
            </section>
          ))}
    </>
  );
}
