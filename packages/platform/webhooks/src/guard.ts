import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { isBlockedAddress } from './address.js';

export type UrlRejection =
  | 'invalid_url'
  | 'not_https'
  | 'credentials'
  | 'port'
  | 'host'
  | 'unresolved'
  | 'private_address';

/** A refused destination. Only a code: the URL or the address that failed is never part of it. */
export class UrlRejected extends Error {
  public constructor(public readonly code: UrlRejection) {
    super(`webhook destination rejected: ${code}`);
    this.name = 'UrlRejected';
  }
}

export const MAX_URL_LENGTH = 2048;
const FORBIDDEN_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home', '.lan'];

export interface ParsedDestination {
  readonly url: URL;
  /** Lowercase DNS name without a trailing dot: also the SNI of the connection. */
  readonly hostname: string;
}

/**
 * The part of the guard that needs no network (SPECS §4.3): `https` only, port 443, no credentials,
 * no fragment, a DNS name and not an address, and no name that is internal by convention.
 */
export function parseDestination(raw: string): ParsedDestination {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH)
    throw new UrlRejected('invalid_url');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlRejected('invalid_url');
  }
  if (url.protocol !== 'https:') throw new UrlRejected('not_https');
  if (url.username !== '' || url.password !== '') throw new UrlRejected('credentials');
  if (url.port !== '' && url.port !== '443') throw new UrlRejected('port');
  if (url.hash !== '') throw new UrlRejected('invalid_url');
  const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
  // IPv6 literals keep their brackets in `hostname`; both literal forms are refused outright.
  if (hostname === '' || isIP(hostname.replace(/^\[|\]$/g, '')) !== 0 || hostname.startsWith('['))
    throw new UrlRejected('host');
  if (
    !hostname.includes('.') ||
    hostname === 'localhost' ||
    FORBIDDEN_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  )
    throw new UrlRejected('host');
  return { url, hostname };
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}
/** The DNS port: every address the name resolves to. */
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));

/**
 * Resolves the name and refuses it if ANY of its addresses is not public (a name that mixes a
 * public and a private address is an attack, not a configuration). Returns the address to connect
 * to: the connection goes to it, so DNS is not asked a second time.
 */
export async function resolvePublic(
  hostname: string,
  resolve: Resolver = systemResolver,
): Promise<ResolvedAddress> {
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new UrlRejected('unresolved');
  }
  const first = addresses[0];
  if (first === undefined) throw new UrlRejected('unresolved');
  if (addresses.some((entry) => isBlockedAddress(entry.address)))
    throw new UrlRejected('private_address');
  return first;
}

/** Registration-time check: syntax and DNS. The same check runs again on every connection. */
export async function validateDestination(
  raw: string,
  resolve: Resolver = systemResolver,
): Promise<void> {
  const { hostname } = parseDestination(raw);
  await resolvePublic(hostname, resolve);
}
