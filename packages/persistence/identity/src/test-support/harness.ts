import { randomUUID } from 'node:crypto';
import {
  IdentityService,
  opaqueTokenGenerator,
  type Identity,
  type Invitation,
  type Membership,
} from '../../../../domain/identity/src/index.js';
import { TypeOrmIdentityStore, type StoreErrorEvent } from '../store.js';
import { FakeDatabase, asDataSource } from './fake-database.js';

export const T0 = new Date('2026-10-06T10:00:00.000Z');
export const HOUR = 60 * 60 * 1000;
export const PROVIDER = 'https://idp.synthetic.test';

export class Clock {
  public current = new Date(T0);
  public readonly now = (): Date => new Date(this.current);
  public advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface Delivery {
  readonly identityId: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export function setup(options: { maxAttempts?: number } = {}) {
  const db = new FakeDatabase();
  const clock = new Clock();
  const events: StoreErrorEvent[] = [];
  const store = new TypeOrmIdentityStore(asDataSource(db), {
    now: clock.now,
    onError: (event) => events.push(event),
    ...options,
  });
  return { db, events, ...createHarness(store, clock) };
}

/** Service plus onboarding helpers over any `TypeOrmIdentityStore` (fake database or real MySQL). */
export function createHarness(store: TypeOrmIdentityStore, clock: Clock) {
  const deliveries: Delivery[] = [];
  const service = new IdentityService(
    store,
    {
      deliver: async (identityId, token, expiresAt) => {
        deliveries.push({ identityId, token, expiresAt });
      },
    },
    opaqueTokenGenerator,
    clock.now,
    { recoveryMinIntervalMs: 0 },
  );

  /** Invites `identityId` (or a new identity) to a tenant with a role; returns the raw token. */
  async function invite(
    tenantId: string,
    role: string,
    identityId: string = randomUUID(),
    ttlMs = 72 * HOUR,
  ) {
    const existing = await store.findIdentity(identityId);
    const now = clock.now();
    const identity: Identity = existing ?? {
      id: identityId,
      status: 'pending',
      mfa: 'disabled',
      authorizationVersion: 1,
      createdAt: now,
    };
    const membership: Membership = {
      id: randomUUID(),
      tenantId,
      identityId,
      status: 'pending',
      createdAt: now,
      activatedAt: null,
    };
    const token = opaqueTokenGenerator.create();
    const invitation: Invitation = {
      id: randomUUID(),
      tenantId,
      identityId,
      tokenHash: opaqueTokenGenerator.hash(token),
      expiresAt: new Date(now.getTime() + ttlMs),
      consumedAt: null,
    };
    await store.createInvitationWithRole(identity, membership, invitation, role, now);
    return { identityId, token, tokenHash: invitation.tokenHash, invitation, membership };
  }

  /** Invites and activates in one step. */
  async function join(tenantId: string, subject: string, role: string, identityId?: string) {
    const invited = await invite(tenantId, role, identityId);
    const activation = await store.activateInvitation(
      invited.tokenHash,
      PROVIDER,
      subject,
      clock.now(),
    );
    if (!activation) throw new Error('test setup: activation failed');
    return { ...invited, activation };
  }

  async function login(identityId: string, tenantId: string) {
    return service.createSession(identityId, tenantId);
  }

  return { clock, deliveries, store, service, invite, join, login };
}

export type Setup = ReturnType<typeof setup>;
