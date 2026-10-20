import { describe, expect, it } from 'vitest';
import { NotificationError } from './errors.js';
import { harness } from './test-support.js';

const code = async (work: Promise<unknown>) =>
  work.then(
    () => 'ok',
    (error: unknown) => (error instanceof NotificationError ? error.code : 'other'),
  );

async function seed(h: ReturnType<typeof harness>, count = 3) {
  for (let i = 0; i < count; i += 1) {
    h.advance(1000);
    await h.ingest.ingest(
      h.event({ entityId: `doc-${i}`, title: `Seguro vence en 7 días · ECO-${i}` }),
    );
  }
}

describe('center', () => {
  it('lists newest first with the unread counter and pages', async () => {
    const h = harness();
    await seed(h);
    const ana = h.actor('A', 'ana');
    const page = await h.service.list(ana, { limit: 2 });
    expect(page.items.map((n) => n.title)).toEqual([
      'Seguro vence en 7 días · ECO-2',
      'Seguro vence en 7 días · ECO-1',
    ]);
    expect(page).toMatchObject({ total: 3, unread: 3 });
    expect((await h.service.list(ana, { limit: 2, offset: 2 })).items).toHaveLength(1);
  });

  it('marks one or all as read and filters unread and by kind', async () => {
    const h = harness();
    await seed(h);
    await h.ingest.ingest(
      h.event({ kind: 'maintenance_overdue', entityType: 'maintenance_plan', entityId: 'p1' }),
    );
    const ana = h.actor('A', 'ana');
    const [first] = (await h.service.list(ana)).items;
    const read = await h.service.markRead(ana, first!.id);
    expect(read.readAt).toBe(h.now().toISOString());
    expect(await h.service.unread(ana)).toBe(3);
    expect((await h.service.list(ana, { unreadOnly: true })).total).toBe(3);
    expect((await h.service.list(ana, { kind: 'document_expiring' })).total).toBe(3);
    // Reading again changes nothing.
    await h.service.markRead(ana, first!.id);
    expect(await h.service.markAllRead(ana)).toBe(3);
    expect(await h.service.unread(ana)).toBe(0);
    expect(await h.service.markAllRead(ana)).toBe(0);
  });

  it('does not let a person read, mark or count the notices of another person or company', async () => {
    const h = harness();
    await seed(h, 1);
    const [mine] = (await h.service.list(h.actor('A', 'ana'))).items;
    expect(await code(h.service.markRead(h.actor('A', 'luis'), mine!.id))).toBe('not_found');
    expect(await code(h.service.markRead(h.actor('B', 'ana'), mine!.id))).toBe('not_found');
    expect(await code(h.service.markRead(h.actor('A', 'ana'), 'no such'))).toBe('not_found');
    expect(await h.service.unread(h.actor('B', 'ana'))).toBe(0);
    expect(await h.service.markAllRead(h.actor('A', 'luis'))).toBe(0);
    expect(await h.service.unread(h.actor('A', 'ana'))).toBe(1);
  });

  it('hides the notices of a kind the person may no longer see', async () => {
    const h = harness();
    await h.ingest.ingest(
      h.event({ kind: 'incident_created', entityType: 'incident', entityId: 'inc-1' }),
    );
    await seed(h, 1);
    const ana = h.actor('A', 'ana');
    expect((await h.service.list(ana)).total).toBe(2);
    h.directory.members.set('A|ana', { permissions: ['view'], mechanicLinked: false });
    const after = h.actor('A', 'ana');
    expect((await h.service.list(after)).items.map((n) => n.eventKind)).toEqual([
      'document_expiring',
    ]);
    expect(await h.service.unread(after)).toBe(1);
    const hidden = (
      await h.store.list('A', 'ana', { kinds: ['incident_created'] }, { limit: 5, offset: 0 })
    ).items[0]!;
    expect(await code(h.service.markRead(after, hidden.id))).toBe('not_found');
    expect(await h.service.markAllRead(after)).toBe(1);
  });

  it('rejects bad queries', async () => {
    const h = harness();
    const ana = h.actor('A', 'ana');
    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { limit: '5' },
      { offset: -1 },
      { kind: 'nope' },
      { unreadOnly: 'yes' },
    ])
      expect(await code(h.service.list(ana, query as never))).toBe('invalid_input');
  });
});

describe('preferences', () => {
  it('shows only the kinds the person may see, with the mandatory ones fixed on', async () => {
    const h = harness();
    const vera = await h.service.preferences(h.actor('A', 'vera'));
    expect(vera.map((row) => row.eventKind)).not.toContain('incident_created');
    expect(vera.find((row) => row.eventKind === 'export_ready')).toMatchObject({
      mandatory: true,
      inApp: true,
      email: true,
      emailAvailable: true,
    });
    expect(vera.find((row) => row.eventKind === 'document_expiring')).toMatchObject({
      mandatory: false,
      inApp: true,
      email: true,
    });
    const sla = (await h.service.preferences(h.actor('A', 'ana'))).find(
      (row) => row.eventKind === 'incident_sla',
    );
    expect(sla).toMatchObject({
      mandatory: true,
      inApp: true,
      email: false,
      emailAvailable: false,
    });
  });

  it('saves choices, refuses to switch off the mandatory notices and unknown or hidden kinds', async () => {
    const h = harness();
    const ana = h.actor('A', 'ana');
    const saved = await h.service.savePreferences(ana, [
      { eventKind: 'document_expiring', inApp: true, email: false },
      { eventKind: 'export_ready', inApp: true, email: true },
    ]);
    expect(saved.find((row) => row.eventKind === 'document_expiring')).toMatchObject({
      inApp: true,
      email: false,
    });
    expect(
      await code(
        h.service.savePreferences(ana, [{ eventKind: 'export_ready', inApp: false, email: true }]),
      ),
    ).toBe('mandatory');
    expect(
      await code(
        h.service.savePreferences(ana, [
          { eventKind: 'work_order_assigned', inApp: true, email: false },
        ]),
      ),
    ).toBe('mandatory');
    // The SLA notice has no e-mail of this module: only the center is fixed.
    expect(
      await h.service.savePreferences(ana, [
        { eventKind: 'incident_sla', inApp: true, email: false },
      ]),
    ).toHaveLength(12);
    for (const input of [
      [{ eventKind: 'nope', inApp: true, email: true }],
      [{ eventKind: 'document_expiring', inApp: 'x', email: true }],
      [
        { eventKind: 'document_expiring', inApp: true, email: true },
        { eventKind: 'document_expiring', inApp: true, email: true },
      ],
      [null],
      'x',
      Array.from({ length: 13 }, () => ({
        eventKind: 'document_expiring',
        inApp: true,
        email: true,
      })),
    ])
      expect(await code(h.service.savePreferences(ana, input as never))).toBe('invalid_input');
    expect(
      await code(
        h.service.savePreferences(h.actor('A', 'vera'), [
          { eventKind: 'incident_created', inApp: true, email: true },
        ]),
      ),
    ).toBe('invalid_input');
  });
});

describe('subscriptions', () => {
  it('follows what the person sees, once, and lists only what they still see', async () => {
    const h = harness();
    const ana = h.actor('A', 'ana');
    const sub = await h.service.subscribe(ana, 'vehicle', 'v1');
    expect(sub).toMatchObject({ tenantId: 'A', recipientId: 'ana', entityType: 'vehicle' });
    await h.service.subscribe(ana, 'vehicle', 'v1');
    await h.service.subscribe(ana, 'incident', 'inc-1');
    expect(await h.service.subscriptions(ana)).toHaveLength(2);
    expect(await h.service.subscriptions(ana, 'incident')).toHaveLength(1);
    h.visibility.hidden.add('A|vehicle|v1');
    expect((await h.service.subscriptions(ana)).map((s) => s.entityId)).toEqual(['inc-1']);
    await h.service.unsubscribe(ana, 'incident', 'inc-1');
    await h.service.unsubscribe(ana, 'incident', 'inc-1');
    expect(await h.service.subscriptions(ana)).toEqual([]);
  });

  it('refuses to follow what the person cannot see or something that is not followable', async () => {
    const h = harness();
    const vera = h.actor('A', 'vera');
    expect(await code(h.service.subscribe(vera, 'incident', 'inc-1'))).toBe('not_found');
    h.visibility.hidden.add('A|vehicle|v9');
    expect(await code(h.service.subscribe(h.actor('A', 'ana'), 'vehicle', 'v9'))).toBe('not_found');
    expect(await code(h.service.subscribe(vera, 'export', 'x'))).toBe('invalid_input');
    expect(await code(h.service.subscribe(vera, 'vehicle', 'bad id'))).toBe('invalid_input');
    expect(await code(h.service.subscribe(vera, 'vehicle', 7))).toBe('invalid_input');
    expect(await code(h.service.unsubscribe(vera, 'nope', 'x'))).toBe('invalid_input');
  });

  it('keeps follows of one company away from the other', async () => {
    const h = harness();
    await h.service.subscribe(h.actor('A', 'ana'), 'vehicle', 'v1');
    expect(await h.service.subscriptions(h.actor('B', 'ana'))).toEqual([]);
    expect(await h.store.subscribersOf('B', 'vehicle', 'v1')).toEqual([]);
    expect(await h.store.subscribersOf('A', 'vehicle', 'v1')).toEqual(['ana']);
  });
});

describe('company rule and failures', () => {
  it('needs manage_config to read or change the rule and the failed deliveries', async () => {
    const h = harness();
    const ana = h.actor('A', 'ana');
    expect(await code(h.service.rule(ana))).toBe('forbidden');
    expect(await code(h.service.saveRule(ana, { emailKinds: [], quietHours: false }))).toBe(
      'forbidden',
    );
    expect(await code(h.service.failedDeliveries(ana))).toBe('forbidden');
  });

  it('starts with every e-mailed kind allowed and no quiet hours, and validates what it saves', async () => {
    const h = harness();
    const root = h.actor('A', 'root');
    const initial = await h.service.rule(root);
    expect(initial).toMatchObject({ quietHours: false, updatedAt: null });
    expect(initial.emailKinds).toContain('export_ready');
    expect(initial.emailKinds).not.toContain('incident_sla');
    const saved = await h.service.saveRule(root, {
      emailKinds: ['export_ready', 'document_expiring', 'export_ready'],
      quietHours: true,
    });
    expect(saved).toMatchObject({
      emailKinds: ['document_expiring', 'export_ready'],
      quietHours: true,
      updatedAt: h.now().toISOString(),
    });
    expect(await h.service.rule(root)).toEqual(saved);
    expect(
      await h.service.rule(
        h.actor('B', 'ana').tenantId === 'B' ? { ...root, tenantId: 'B' } : root,
      ),
    ).toMatchObject({
      quietHours: false,
    });
    for (const input of [
      { emailKinds: ['incident_sla'], quietHours: false },
      { emailKinds: ['nope'], quietHours: false },
      { emailKinds: 'x', quietHours: false },
      { emailKinds: [], quietHours: 'yes' },
    ])
      expect(await code(h.service.saveRule(root, input as never))).toBe('invalid_input');
    expect(await code(h.service.failedDeliveries(root, { limit: 0 }))).toBe('invalid_input');
    expect(await h.service.failedDeliveries(root)).toEqual({ items: [], total: 0 });
  });
});
