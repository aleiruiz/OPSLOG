/** One authenticated session of the synthetic administrator: the Cookie header and its CSRF token. */
export interface LoadSession {
  readonly cookie: string;
  readonly csrf: string;
}
export interface LoadFixture {
  readonly origin: string;
  readonly areaId: string;
  /** Differs on every run (four hex digits): unique names for what the run writes. */
  readonly run?: string;
  readonly sessions: readonly LoadSession[];
  readonly vehicleIds: readonly string[];
  readonly platePrefixes: readonly string[];
  readonly plateInfixes: readonly string[];
}
export function pick<T>(list: readonly T[], vu: number, iter: number): T;
export function expand(template: string, fixture: LoadFixture, vu: number, iter: number): string;
export function expandBody(
  body: unknown,
  fixture: LoadFixture,
  vu: number,
  iter: number,
): string | undefined;
export function percentile(values: readonly number[], fraction: number): number;
