import SearchIcon from '@mui/icons-material/Search';
import Box from '@mui/material/Box';
import InputBase from '@mui/material/InputBase';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { BffSearchHit, BffSearchResult } from '@opslog/contracts';
import { opslogTokens } from '@opslog/ui';
import { useRouter } from '../../app/router';
import {
  MIN_SEARCH_LENGTH,
  resultsAnnouncement,
  resultsPath,
  searchCopy,
  searchErrorMessage,
  searchTypeLabels,
} from './labels';
import type { SearchPorts } from './ports';
import { totalHits, useSearch } from './useSearch';

const { colors } = opslogTokens;
const LIST_ID = 'busqueda-resultados';

interface Flat extends BffSearchHit {
  readonly key: string;
}

const flatten = (result: BffSearchResult): Flat[] =>
  result.groups.flatMap((group) =>
    group.items.map((item) => ({ ...item, key: `busqueda-${group.type}-${item.id}` })),
  );

/**
 * Global search combobox of the top bar (FR-160): ARIA 1.2 list autocomplete. Arrow keys move
 * through the hits, Enter opens the active hit or, with none, the full results page; Escape closes.
 */
export function SearchBox({
  ports,
  onExpired,
  disabled = false,
}: {
  ports: SearchPorts;
  onExpired: () => void;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [text, setText] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(-1);
  const root = React.useRef<HTMLDivElement>(null);
  const state = useSearch(ports, text, onExpired);
  const flat = state.status === 'ready' ? flatten(state.result) : [];
  const term = text.trim();
  const showPanel = open && term.length >= MIN_SEARCH_LENGTH;
  const hasList = state.status === 'ready' && flat.length > 0;
  const message =
    state.status === 'ready'
      ? flat.length === 0
        ? searchCopy.empty
        : null
      : state.status === 'error'
        ? searchErrorMessage(state.error)
        : searchCopy.loading;
  const activeKey = showPanel && active >= 0 ? flat[active]?.key : undefined;

  React.useEffect(() => setActive(-1), [state]);
  React.useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const go = (to: string) => {
    setOpen(false);
    setText('');
    router.navigate(to);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      if (flat.length === 0) return;
      const down = event.key === 'ArrowDown';
      setActive((index) =>
        index < 0
          ? down
            ? 0
            : flat.length - 1
          : (index + (down ? 1 : -1) + flat.length) % flat.length,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const hit = activeKey ? flat[active] : undefined;
      if (hit) go(hit.href);
      else if (term.length >= MIN_SEARCH_LENGTH) go(resultsPath(term));
    }
  };

  return (
    <Box
      ref={root}
      role="search"
      sx={{ position: 'relative', flex: { xs: 1, md: '0 1 360px' }, minWidth: 0 }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 1,
          border: `1px solid ${colors.border}`,
          borderRadius: 1,
          bgcolor: colors.background,
          '&:focus-within': { outline: `2px solid ${colors.primary}`, outlineOffset: 1 },
        }}
      >
        <SearchIcon fontSize="small" aria-hidden="true" />
        <InputBase
          value={text}
          disabled={disabled}
          placeholder={searchCopy.placeholder}
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          sx={{ flex: 1, minWidth: 0, py: 0.25 }}
          inputProps={{
            role: 'combobox',
            'aria-label': searchCopy.label,
            'aria-autocomplete': 'list',
            'aria-expanded': showPanel && hasList,
            ...(showPanel && hasList ? { 'aria-controls': LIST_ID } : {}),
            'aria-activedescendant': activeKey,
            maxLength: 64,
            autoComplete: 'off',
          }}
        />
      </Box>
      <Box component="div" role="status" className="sr-only">
        {showPanel
          ? state.status === 'ready' && hasList
            ? resultsAnnouncement(totalHits(state.result))
            : message
          : ''}
      </Box>
      {showPanel && (
        <Box
          sx={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            mt: 0.5,
            zIndex: 1,
            maxHeight: '70vh',
            overflowY: 'auto',
            bgcolor: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 1,
            boxShadow: 3,
            py: 0.5,
          }}
        >
          {/* Messages live outside the listbox: a listbox may only contain options. */}
          {message && (
            <Typography variant="body2" sx={{ px: 1.5, py: 1 }}>
              {message}
            </Typography>
          )}
          {state.status === 'ready' && hasList && (
            <Box id={LIST_ID} role="listbox" aria-label={searchCopy.title}>
              {state.result.groups.map((group) => (
                <Box key={group.type} role="group" aria-label={searchTypeLabels[group.type]}>
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ px: 1.5, display: 'block' }}
                    aria-hidden="true"
                  >
                    {searchTypeLabels[group.type]} ({group.total})
                  </Typography>
                  {group.items.map((item) => {
                    const key = `busqueda-${group.type}-${item.id}`;
                    return (
                      <Box
                        key={key}
                        id={key}
                        role="option"
                        aria-selected={key === activeKey}
                        onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
                        onClick={() => go(item.href)}
                        sx={{
                          px: 1.5,
                          py: 0.75,
                          cursor: 'pointer',
                          bgcolor: key === activeKey ? colors.primarySoft : 'transparent',
                          '&:hover': { bgcolor: colors.primarySoft },
                        }}
                      >
                        {item.label}
                      </Box>
                    );
                  })}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
