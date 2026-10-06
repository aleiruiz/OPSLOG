/** Names of the identity-store calls whose latency a test can inject. */
export type Slow = 'activateInvitation' | 'revokeMembership' | 'setTenantStatus';

/**
 * Wraps an identity store so the named calls wait before running and announce that they started.
 * It lets a test interleave two operations deterministically, in either order, without touching
 * the clock (only `Date` is faked by the test worlds, so timers keep working).
 */
export function withLatency<T extends object>(
  store: T,
  delays: Readonly<Partial<Record<Slow, number>>>,
) {
  const resolvers = new Map<Slow, () => void>();
  const started = new Map<Slow, Promise<void>>();
  for (const name of Object.keys(delays) as Slow[])
    started.set(name, new Promise<void>((resolve) => resolvers.set(name, resolve)));
  const arm = (name: Slow) =>
    started.set(name, new Promise<void>((resolve) => resolvers.set(name, resolve)));
  const wrapped = new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      const name = property as Slow;
      if (!(name in delays))
        return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args);
      return async (...args: unknown[]) => {
        resolvers.get(name)?.();
        await new Promise((resolve) => setTimeout(resolve, delays[name] ?? 0));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    store: wrapped,
    started: (name: Slow) => started.get(name) as Promise<void>,
    /** Forgets earlier calls, so `started` waits for the next one (fixtures also use the store). */
    rearm: arm,
  };
}
