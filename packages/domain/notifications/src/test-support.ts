import {
  SinkMailAdapter,
  type MailMessage,
  type MailPort,
} from '../../../platform/mail/src/index.js';
import type { Permission } from '../../identity/src/index.js';
import type { EntityType } from './catalog.js';
import { NotificationDispatcher, type DispatchDeps } from './dispatch.js';
import { NotificationIngest, type NotificationEvent } from './ingest.js';
import type { EntityVisibility, MemberAccess, RecipientDirectory } from './ports.js';
import { NotificationService, type NotificationActor } from './service.js';
import { InMemoryNotificationStore } from './store.js';

export const FLEET: readonly Permission[] = ['view', 'create', 'edit', 'incidents:view'];
export const VIEWER: readonly Permission[] = ['view'];
export const ADMIN: readonly Permission[] = [
  'view',
  'edit',
  'manage_config',
  'manage_users',
  'approve',
  'incidents:view',
  'incidents:edit',
];

/** A directory of members and addresses the tests change as they go. */
export class FakeDirectory implements RecipientDirectory {
  public readonly members = new Map<string, MemberAccess>();
  public readonly addresses = new Map<string, string>();
  public zone = 'America/Mexico_City';
  public name = 'Empresa Alfa';
  public add(tenantId: string, id: string, permissions: readonly Permission[], mechanic = false) {
    this.members.set(`${tenantId}|${id}`, { permissions, mechanicLinked: mechanic });
    this.addresses.set(`${tenantId}|${id}`, `${id}@example.test`);
  }
  public async access(tenantId: string, id: string) {
    return this.members.get(`${tenantId}|${id}`) ?? null;
  }
  public async address(tenantId: string, id: string) {
    return this.addresses.get(`${tenantId}|${id}`) ?? null;
  }
  public async company() {
    return { name: this.name, timeZone: this.zone };
  }
}

/** Entities every member with `view` sees, except the ones the test hides. */
export class FakeVisibility implements EntityVisibility {
  public readonly hidden = new Set<string>();
  public async visible(tenantId: string, access: MemberAccess, type: EntityType, id: string) {
    const needs = type === 'incident' ? 'incidents:view' : 'view';
    return (
      (access.permissions as readonly string[]).includes(needs) &&
      !this.hidden.has(`${tenantId}|${type}|${id}`)
    );
  }
}

export class FailingMail implements MailPort {
  public calls = 0;
  public constructor(
    private readonly failure: unknown = new Error('provider said ana@example.test'),
  ) {}
  public async send(_message: MailMessage): Promise<void> {
    this.calls += 1;
    throw this.failure;
  }
}

export function harness(options: { mail?: MailPort; baseUrl?: string } = {}) {
  let clock = new Date('2026-10-19T15:00:00.000Z').getTime();
  const now = () => new Date(clock);
  let ids = 0;
  const store = new InMemoryNotificationStore();
  const directory = new FakeDirectory();
  const visibility = new FakeVisibility();
  const sink = new SinkMailAdapter({ retain: 100 });
  const mail = options.mail ?? sink;
  const deps = { store, directory, visibility, now };
  const ingest = new NotificationIngest({ ...deps, newId: () => `n-${(ids += 1)}` });
  const dispatchDeps: DispatchDeps = {
    ...deps,
    mail,
    random: () => 0.5,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  };
  const dispatcher = new NotificationDispatcher(dispatchDeps);
  const service = new NotificationService(deps);
  directory.add('A', 'ana', FLEET);
  directory.add('A', 'luis', FLEET);
  directory.add('A', 'root', ADMIN);
  directory.add('A', 'vera', VIEWER);
  directory.add('B', 'ana', FLEET);
  const actor = (tenantId: string, recipientId: string): NotificationActor => ({
    tenantId,
    recipientId,
    access: directory.members.get(`${tenantId}|${recipientId}`) as MemberAccess,
  });
  const event = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
    tenantId: 'A',
    kind: 'document_expiring',
    entityType: 'vehicle',
    entityId: 'doc-1',
    title: 'Seguro vence en 7 días · ECO-1',
    link: '/flota/vehiculos/v1',
    severity: 'attention',
    dateVersion: '2026-10-26',
    threshold: 'd7',
    recipients: ['ana'],
    ...over,
  });
  return {
    store,
    directory,
    visibility,
    sink,
    ingest,
    dispatcher,
    service,
    actor,
    event,
    now,
    advance: (ms: number) => {
      clock += ms;
    },
    setNow: (iso: string) => {
      clock = Date.parse(iso);
    },
  };
}
