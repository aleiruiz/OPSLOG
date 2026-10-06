import Link from '@mui/material/Link';
import { Button } from '@opslog/ui';
import React from 'react';

/** Minimal History API router: the shell only needs pathname matching, no nested data loading. */
interface RouterValue {
  readonly path: string;
  readonly search: URLSearchParams;
  readonly basename: string;
  navigate(to: string, options?: { readonly replace?: boolean }): void;
}

const RouterContext = React.createContext<RouterValue | null>(null);

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange);
  window.addEventListener('opslog:navigate', onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    window.removeEventListener('opslog:navigate', onChange);
  };
}
const snapshot = () => `${window.location.pathname}${window.location.search}`;

export function RouterProvider({
  basename = '',
  children,
}: {
  basename?: string;
  children: React.ReactNode;
}) {
  const location = React.useSyncExternalStore(subscribe, snapshot, snapshot);
  const value = React.useMemo<RouterValue>(() => {
    const queryStart = location.indexOf('?');
    const pathname = queryStart === -1 ? location : location.slice(0, queryStart);
    const search = new URLSearchParams(queryStart === -1 ? '' : location.slice(queryStart));
    const path = pathname.startsWith(basename) ? pathname.slice(basename.length) || '/' : pathname;
    return {
      path,
      search,
      basename,
      navigate: (to, options) => {
        const target = `${basename}${to}`;
        try {
          if (options?.replace) window.history.replaceState(null, '', target);
          else window.history.pushState(null, '', target);
        } catch {
          // History API refused the URL (e.g. a malformed target): stay on the current screen.
          return;
        }
        window.dispatchEvent(new Event('opslog:navigate'));
      },
    };
  }, [location, basename]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterValue {
  const value = React.useContext(RouterContext);
  if (!value) throw new Error('useRouter requires a RouterProvider');
  return value;
}

export function RouterLink({
  to,
  children,
  current = false,
  label,
  sx,
}: {
  to: string;
  children: React.ReactNode;
  current?: boolean;
  /** Accessible name when the visible text alone is ambiguous (several "Editar" links in a table). */
  label?: string;
  sx?: React.ComponentProps<typeof Link>['sx'];
}) {
  const router = useRouter();
  return (
    <Link
      href={`${router.basename}${to}`}
      aria-current={current ? 'page' : undefined}
      aria-label={label}
      underline="none"
      {...(sx ? { sx } : {})}
      onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        router.navigate(to);
      }}
    >
      {children}
    </Link>
  );
}

/** A link that looks like a button: keeps link semantics (open in a new tab, copy address) with SPA navigation. */
export function RouterButton({
  to,
  children,
  variant = 'outlined',
}: {
  to: string;
  children: React.ReactNode;
  variant?: 'contained' | 'outlined' | 'text';
}) {
  const router = useRouter();
  return (
    <Button
      href={`${router.basename}${to}`}
      variant={variant}
      onClick={(event: React.MouseEvent<HTMLElement>) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        router.navigate(to);
      }}
    >
      {children}
    </Button>
  );
}
