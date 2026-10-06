import { vi } from 'vitest';
import {
  FakeOidcVerifier,
  InMemoryTenantStore,
  createPlatform,
  type Platform,
  type RoleName,
} from '../../composition/src/index.js';
import { createBffHandler, type BffOptions } from './handler.js';
import type { BffHandler } from './http.js';

export const ORIGIN = 'https://app.synthetic.test';
export const HOST = 'app.synthetic.test';
export const SECRET = 'synthetic-bff-secret-for-tests-0123456789';
export const START = new Date('2026-10-06T12:00:00.000Z');

export interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly text: string;
  readonly json: any;
  readonly setCookies: readonly string[];
}

export interface SendInit {
  readonly json?: unknown;
  readonly raw?: string | Uint8Array | readonly Uint8Array[];
  readonly headers?: Readonly<Record<string, string>>;
  /** `null` omits the header; default is the allowed origin. */
  readonly origin?: string | null;
  readonly host?: string | null;
  readonly contentType?: string | null;
  /** `null` omits the header, a string overrides it, default is the session (or pre-login) token. */
  readonly csrf?: string | null;
  /** Sends the jar cookies (default true). */
  readonly cookies?: boolean;
  readonly cookieHeader?: string;
}

async function* chunked(parts: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield part;
}

/** A browser stand-in: one cookie jar, `credentials: same-origin` requests, JS can read bodies only. */
export class Browser {
  public readonly jar = new Map<string, string>();
  /** CSRF token the page holds (from `/api/auth/csrf` or the session body). */
  public csrf: string | null = null;
  public constructor(private readonly handler: BffHandler) {}

  public async send(method: string, path: string, init: SendInit = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...init.headers };
    const hasBody = init.json !== undefined || init.raw !== undefined;
    if (method !== 'GET') {
      if (init.origin !== null) headers['origin'] = init.origin ?? ORIGIN;
      headers['sec-fetch-site'] ??= 'same-origin';
    }
    if (init.host !== null) headers['host'] = init.host ?? HOST;
    if (hasBody && init.contentType !== null)
      headers['content-type'] = init.contentType ?? 'application/json';
    if (method !== 'GET' && init.csrf !== null) {
      const token = init.csrf ?? this.csrf;
      if (token) headers['x-csrf-token'] = token;
    }
    const cookie =
      init.cookieHeader ??
      (init.cookies === false
        ? ''
        : [...this.jar].map(([name, value]) => `${name}=${value}`).join('; '));
    if (cookie) headers['cookie'] = cookie;

    let parts: Uint8Array[] = [];
    if (init.json !== undefined) parts = [Buffer.from(JSON.stringify(init.json))];
    else if (typeof init.raw === 'string') parts = [Buffer.from(init.raw)];
    else if (init.raw instanceof Uint8Array) parts = [init.raw];
    else if (init.raw) parts = [...init.raw];
    const response = await this.handler({
      method,
      url: path,
      headers,
      body: hasBody ? chunked(parts) : null,
    });
    const setCookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
    for (const line of setCookies) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      const expired = attributes.some((attribute) => attribute === 'Max-Age=0');
      if (expired || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
    let json: unknown = null;
    try {
      json = response.body ? JSON.parse(response.body) : null;
    } catch {
      json = null;
    }
    return {
      status: response.status,
      headers: response.headers,
      text: response.body,
      json,
      setCookies,
    };
  }
  public get(path: string, init: SendInit = {}): Promise<Reply> {
    return this.send('GET', path, init);
  }
  public post(path: string, init: SendInit = {}): Promise<Reply> {
    return this.send('POST', path, init);
  }
  public put(path: string, init: SendInit = {}): Promise<Reply> {
    return this.send('PUT', path, init);
  }
  public delete(path: string, init: SendInit = {}): Promise<Reply> {
    return this.send('DELETE', path, init);
  }
}

export interface BffWorldOptions {
  readonly bff?: Partial<Omit<BffOptions, 'platform'>>;
}

/**
 * Platform + BFF handler over in-memory adapters with a controllable clock (only `Date` is faked).
 * Call `world.dispose()` in `afterEach`.
 */
export function createBffWorld(options: BffWorldOptions = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  const verifier = new FakeOidcVerifier();
  const platform: Platform = createPlatform({
    verifier,
    issuer: verifier.issuer,
    grantSecret: 'synthetic-grant-secret-for-tests-0123456789',
    adapters: { tenants: new InMemoryTenantStore() },
  });
  const errors: { correlationId: string; route: string; errorClass: string }[] = [];
  const handler = createBffHandler({
    platform,
    secret: SECRET,
    allowedOrigins: [ORIGIN],
    onError: (event) => errors.push(event),
    ...options.bff,
  });
  let counter = 0;
  const nonce = () => `nonce-${(counter += 1)}`;

  const principal = async (subject: string) => {
    const n = nonce();
    const result = await platform.verifyPrincipal(verifier.issueCode(subject, n), n);
    if (!result.ok || !result.value) throw new Error('principal fixture failed');
    return result.value;
  };
  /** Code and nonce a browser would obtain from the (fake) identity provider. */
  const credentials = (subject: string) => {
    const n = nonce();
    return { code: verifier.issueCode(subject, n), nonce: n };
  };

  const browser = () => new Browser(handler);

  /** Fetches the pre-login CSRF token, as the login page does. */
  const prepare = async (b: Browser): Promise<void> => {
    const reply = await b.get('/api/auth/csrf');
    b.csrf = reply.json.csrfToken as string;
  };

  /** Signs in over HTTP and returns a browser holding the cookie and the session CSRF token. */
  const loginAs = async (subject: string): Promise<Browser> => {
    const b = browser();
    await prepare(b);
    const reply = await b.post('/api/auth/login', { json: credentials(subject) });
    if (reply.status !== 200) throw new Error(`login fixture failed: ${reply.status}`);
    b.csrf = reply.json.csrfToken as string;
    return b;
  };

  /** Creates a tenant with its first administrator (operator action, outside HTTP). */
  const tenant = async (name: string, adminSubject: string) => {
    const created = await platform.bootstrapTenant({
      name,
      adminPrincipal: await principal(adminSubject),
    });
    if (!created.ok || !created.value) throw new Error('tenant fixture failed');
    return {
      tenantId: created.value.tenantId,
      adminSubject,
      adminId: created.value.adminIdentityId,
    };
  };

  /** Adds an active member with a role through the real invitation flow. */
  const member = async (
    adminSubject: string,
    role: RoleName,
    subject: string,
  ): Promise<{ identityId: string }> => {
    const login = await platform.signIn(await principal(adminSubject));
    if (!login.ok || !login.value) throw new Error('admin sign-in fixture failed');
    const invited = await platform.inviteUser(login.value.token, 'fixture', role);
    if (!invited.ok || !invited.value) throw new Error('invite fixture failed');
    const accepted = await platform.acceptInvitation(
      invited.value.invitationToken,
      await principal(subject),
    );
    if (!accepted.ok || !accepted.value) throw new Error('accept fixture failed');
    await platform.signOut(login.value.token);
    return { identityId: accepted.value.identityId };
  };

  const advance = (ms: number): void => {
    vi.setSystemTime(new Date(Date.now() + ms));
  };

  return {
    platform,
    verifier,
    handler,
    errors,
    browser,
    prepare,
    loginAs,
    credentials,
    principal,
    tenant,
    member,
    advance,
    dispose: () => vi.useRealTimers(),
  };
}

export type BffWorld = ReturnType<typeof createBffWorld>;
