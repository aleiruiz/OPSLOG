import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import {
  createPlatform,
  InMemoryTenantStore,
  type Platform,
  type RoleName,
} from '../../apps/api/composition/src/index.js';
import { createBffHandler, createBffServer } from '../../apps/api/bff/src/index.js';
import type { BffHandler } from '../../apps/api/bff/src/http.js';
import type { ExternalClaims, OidcVerifier } from '../../packages/platform/auth/src/index.js';
import { EnvelopePiiCipher, LocalDevKms } from '../../packages/platform/pii/src/index.js';
import {
  startFleetDatabase,
  type FleetDatabase,
  type FleetTenantDatabase,
} from '../../tests/e2e/fleet/mysql.js';

const ISSUER = 'https://idp.e2e.synthetic.test';
const CODE_PREFIX = 'fake-code:';

/** Accepts the web fake provider's codes (`fake-code:<account>`): synthetic identities only. */
class BrowserFakeVerifier implements OidcVerifier {
  public async verify(
    code: string,
    expectedIssuer: string,
    expectedNonce: string,
  ): Promise<ExternalClaims> {
    if (!code.startsWith(CODE_PREFIX) || code.length <= CODE_PREFIX.length)
      throw new Error('unknown code');
    return {
      issuer: expectedIssuer,
      subject: code.slice(CODE_PREFIX.length),
      nonce: expectedNonce,
    };
  }
}

/** A tenant store that provisions exactly the tenant its physical database is bound to. */
class BoundTenantStore extends InMemoryTenantStore {
  public readonly tenantId: string;
  private available = true;
  private readonly provisioned: ReturnType<InMemoryTenantStore['provisionVerified']>;
  public constructor(private readonly tenantName: string) {
    super();
    this.provisioned = super.provisionVerified(tenantName);
    this.tenantId = this.provisioned.id;
  }
  public override provisionVerified(
    name: string,
  ): ReturnType<InMemoryTenantStore['provisionVerified']> {
    if (!this.available || name !== this.tenantName) throw new Error('harness tenant is pre-bound');
    this.available = false;
    return this.provisioned;
  }
}

export interface RealTenant {
  readonly platform: Platform;
  readonly database: FleetTenantDatabase;
  readonly tenantId: string;
  readonly webUrl: string;
  /** Adds an active member with a role through the real invitation flow. */
  member(role: RoleName, subject: string): Promise<string>;
  /** Creates an area and a vehicle as the tenant administrator; returns the vehicle id. */
  vehicle(tag: string): Promise<string>;
}

async function principal(platform: Platform, subject: string) {
  const nonce = `harness-${Math.random().toString(36).slice(2)}`;
  const result = await platform.verifyPrincipal(`${CODE_PREFIX}${subject}`, nonce);
  if (!result.ok || !result.value) throw new Error('harness principal failed');
  return result.value;
}

async function composeTenant(database: FleetTenantDatabase, name: string, admin: string) {
  const tenants = new BoundTenantStore(name);
  database.runtime.bindTenant(tenants.tenantId);
  const platform = createPlatform({
    verifier: new BrowserFakeVerifier(),
    issuer: ISSUER,
    grantSecret: 'synthetic-e2e-grant-secret-0123456789abcdef',
    adapters: {
      tenants,
      ...database.runtime.adapters,
      pii: new EnvelopePiiCipher(LocalDevKms.ephemeral('e2e')),
    },
  });
  const created = await platform.bootstrapTenant({
    name,
    adminPrincipal: await principal(platform, admin),
  });
  if (!created.ok || !created.value) throw new Error('harness tenant failed');
  return { platform, tenantId: created.value.tenantId };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/**
 * The real web shell (`/real/...`) served by Vite and proxied to the composed BFF over a disposable
 * synthetic MySQL 8.4 database. One stack per tenant: each tenant has its own physical database.
 */
export async function startRealStack(): Promise<{
  a: RealTenant;
  b: RealTenant;
  close(): Promise<void>;
}> {
  const database: FleetDatabase = await startFleetDatabase();
  const closers: (() => Promise<void>)[] = [() => database.close()];
  const stack = async (
    tenantDb: FleetTenantDatabase,
    name: string,
    admin: string,
  ): Promise<RealTenant> => {
    const { platform, tenantId } = await composeTenant(tenantDb, name, admin);
    // The BFF must know the browser origin, which exists only once Vite listens: route through a slot.
    let handler: BffHandler = async () => ({ status: 503, headers: {}, body: '' });
    const bffServer = createBffServer((request) => handler(request));
    const bffPort = await listen(bffServer);
    closers.push(() => new Promise<void>((resolve) => bffServer.close(() => resolve())));
    // The harness's own Vite config (aliases, SPA fallback for /real), plus the proxy to this BFF.
    const vite: ViteDevServer = await createViteServer({
      configFile: fileURLToPath(new URL('../vite.config.mjs', import.meta.url)),
      server: {
        host: 'localhost',
        strictPort: false,
        // Keep the browser's Host: the BFF requires Origin and Host to match.
        proxy: { '/api': { target: `http://127.0.0.1:${bffPort}`, changeOrigin: false } },
      },
      logLevel: 'error',
    });
    await vite.listen();
    // `localhost` (not 127.0.0.1): browsers keep the BFF's Secure cookies on it over plain http.
    const address = vite.httpServer?.address() as AddressInfo;
    const webUrl = `http://localhost:${address.port}`;
    closers.push(() => vite.close());
    handler = createBffHandler({
      platform,
      secret: 'synthetic-e2e-csrf-secret-0123456789abcdef',
      allowedOrigins: [webUrl],
    });
    return {
      platform,
      database: tenantDb,
      tenantId,
      webUrl,
      async member(role, subject) {
        const login = await platform.signIn(await principal(platform, admin));
        if (!login.ok || !login.value) throw new Error('harness admin sign-in failed');
        const invited = await platform.inviteUser(login.value.token, 'harness', role);
        if (!invited.ok || !invited.value) throw new Error('harness invite failed');
        const accepted = await platform.acceptInvitation(
          invited.value.invitationToken,
          await principal(platform, subject),
        );
        if (!accepted.ok || !accepted.value) throw new Error('harness accept failed');
        await platform.signOut(login.value.token);
        return accepted.value.identityId;
      },
      async vehicle(tag) {
        const login = await platform.signIn(await principal(platform, admin));
        if (!login.ok || !login.value) throw new Error('harness admin sign-in failed');
        const token = login.value.token;
        const area = await platform.areas.create(token, `seed-area-${tag}`, {
          name: `Área ${tag}`,
          code: null,
          parentId: null,
          responsibleIds: [],
        });
        if (!area.ok || !area.value) throw new Error('harness area failed');
        const vehicle = await platform.vehicles.create(token, `seed-vehicle-${tag}`, {
          economicNumber: `MNT-${tag}`,
          plate: `MN${tag}`,
          vin: null,
          make: 'Toyota',
          model: 'Hilux',
          year: 2022,
          areaId: area.value.id,
          odometerKm: 100,
        });
        if (!vehicle.ok || !vehicle.value) throw new Error('harness vehicle failed');
        await platform.signOut(token);
        return vehicle.value.id;
      },
    };
  };
  try {
    const a = await stack(database.tenantA, 'Empresa Sintética A', 'e2e-admin-a');
    const b = await stack(database.tenantB, 'Empresa Sintética B', 'e2e-admin-b');
    return {
      a,
      b,
      async close() {
        for (const close of closers.reverse()) await close().catch(() => undefined);
      },
    };
  } catch (error) {
    for (const close of closers.reverse()) await close().catch(() => undefined);
    throw error;
  }
}
