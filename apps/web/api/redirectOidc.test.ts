import { describe, expect, it, vi } from 'vitest';
import { createRedirectOidc } from './redirectOidc';

const config = {
  domain: 'https://login.example.test',
  clientId: 'client-1',
  redirectUri: 'https://app.example.test/auth/callback',
};

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

function setup() {
  const storage = memoryStorage();
  const navigate = vi.fn();
  let counter = 0;
  const randomBytes = (length: number) => new Uint8Array(length).fill(++counter);
  const oidc = createRedirectOidc(config, { storage, navigate, randomBytes });
  return { oidc, storage, navigate };
}

async function start(context = {}) {
  const parts = setup();
  void parts.oidc.authorize('', context);
  await vi.waitFor(() => expect(parts.navigate).toHaveBeenCalled());
  const url = new URL(parts.navigate.mock.calls[0]?.[0] as string);
  return { ...parts, url };
}

describe('redirecting identity provider', () => {
  it('sends the browser to the hosted page with code + PKCE S256, state and nonce', async () => {
    const { url, oidc, storage } = await start({ next: '/flota' });
    expect(oidc.redirects).toBe(true);
    expect(`${url.origin}${url.pathname}`).toBe('https://login.example.test/oauth2/authorize');
    const query = url.searchParams;
    expect(query.get('response_type')).toBe('code');
    expect(query.get('client_id')).toBe('client-1');
    expect(query.get('redirect_uri')).toBe(config.redirectUri);
    expect(query.get('scope')).toBe('openid');
    expect(query.get('code_challenge_method')).toBe('S256');
    expect(query.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(query.get('state')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(query.get('nonce')).toMatch(/^[A-Za-z0-9_-]+$/);
    // The verifier itself never goes in the address.
    const pending = JSON.parse(storage.data.get('opslog.oidc.pending') as string);
    expect(url.toString()).not.toContain(pending.verifier);
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  });

  it('completes only with the matching state, once, handing back the verifier and context', async () => {
    const { oidc, url } = await start({ invitationToken: 'tok' });
    const state = url.searchParams.get('state') as string;
    const done = oidc.complete?.(new URLSearchParams({ code: 'abc', state }));
    expect(done).toMatchObject({
      ok: true,
      value: {
        credentials: { code: 'abc', nonce: url.searchParams.get('nonce') },
        context: { invitationToken: 'tok' },
      },
    });
    if (!done?.ok) throw new Error('expected success');
    expect(done.value.credentials.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    // Consumed: a replay of the same callback fails.
    expect(oidc.complete?.(new URLSearchParams({ code: 'abc', state })).ok).toBe(false);
  });

  it('rejects a wrong state, a provider error, a missing code and a stale attempt', async () => {
    for (const make of [
      (state: string) => new URLSearchParams({ code: 'abc', state: `${state}x` }),
      (state: string) => new URLSearchParams({ error: 'access_denied', code: 'abc', state }),
      (state: string) => new URLSearchParams({ state }),
    ]) {
      const { oidc, url } = await start();
      const result = oidc.complete?.(make(url.searchParams.get('state') as string));
      expect(result).toMatchObject({ ok: false, error: { status: 401 } });
    }
    vi.useFakeTimers();
    try {
      const { oidc, url } = await start();
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      expect(
        oidc.complete?.(
          new URLSearchParams({ code: 'a', state: url.searchParams.get('state') as string }),
        ).ok,
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails without a pending attempt or when storage is unavailable', async () => {
    const { oidc } = setup();
    expect(oidc.complete?.(new URLSearchParams({ code: 'a', state: 's' }))).toMatchObject({
      ok: false,
      error: { status: 400 },
    });
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => undefined,
    };
    const navigate = vi.fn();
    const blocked = createRedirectOidc(config, { storage: broken, navigate });
    expect(await blocked.authorize('')).toMatchObject({ ok: false, error: { status: 500 } });
    expect(navigate).not.toHaveBeenCalled();
    expect(blocked.complete?.(new URLSearchParams({ code: 'a' })).ok).toBe(false);
  });
});
