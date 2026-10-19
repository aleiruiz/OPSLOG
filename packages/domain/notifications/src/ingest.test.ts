import { describe, expect, it } from 'vitest';
import { NotificationError } from './errors.js';
import { harness } from './test-support.js';

const list = (h: ReturnType<typeof harness>, tenantId = 'A', id = 'ana') =>
  h.service.list(h.actor(tenantId, id));

describe('ingest and the unique key', () => {
  it('writes one notice per recipient and a second scan of the same cycle writes nothing', async () => {
    const h = harness();
    const first = await h.ingest.ingest(h.event({ recipients: ['ana', 'luis'] }));
    expect(first).toEqual({ created: 2, duplicates: 0, skipped: 0 });
    const again = await h.ingest.ingest(h.event({ recipients: ['ana', 'luis'] }));
    expect(again).toEqual({ created: 0, duplicates: 2, skipped: 0 });
    expect((await list(h)).total).toBe(1);
    expect((await list(h, 'A', 'luis')).total).toBe(1);
  });

  it('starts the cycle again when the due date changes and keeps one notice per threshold', async () => {
    const h = harness();
    await h.ingest.ingest(h.event());
    await h.ingest.ingest(
      h.event({ threshold: 'd0', title: 'Seguro vence hoy o ya venció · ECO-1' }),
    );
    expect((await list(h)).total).toBe(2);
    const renewed = await h.ingest.ingest(h.event({ dateVersion: '2027-10-26' }));
    expect(renewed.created).toBe(1);
    expect((await list(h)).total).toBe(3);
  });

  it('keeps companies apart even with the same ids', async () => {
    const h = harness();
    await h.ingest.ingest(h.event({ tenantId: 'A' }));
    await h.ingest.ingest(h.event({ tenantId: 'B' }));
    expect((await list(h, 'A')).total).toBe(1);
    expect((await list(h, 'B')).total).toBe(1);
    expect((await list(h, 'A')).items[0]?.tenantId).toBe('A');
    expect(h.sink.messages).toHaveLength(0);
    await h.dispatcher.runDue('A');
    expect(h.sink.messages.map((m) => m.companyId)).toEqual(['A']);
    expect(await h.service.unread(h.actor('B', 'ana'))).toBe(1);
  });

  it('drops candidates that are not members, lack the right or no longer see the entity', async () => {
    const h = harness();
    h.visibility.hidden.add('A|vehicle|doc-1');
    const result = await h.ingest.ingest(h.event({ recipients: ['ana', 'nobody', 'vera'] }));
    expect(result).toEqual({ created: 0, duplicates: 0, skipped: 3 });
    h.visibility.hidden.clear();
    const incident = await h.ingest.ingest(
      h.event({
        kind: 'incident_created',
        entityType: 'incident',
        entityId: 'inc-1',
        recipients: ['ana', 'vera'],
      }),
    );
    // `vera` only has `view`: incidents need `incidents:view`.
    expect(incident).toEqual({ created: 1, duplicates: 0, skipped: 1 });
  });

  it('scopes mechanics out of incident notices', async () => {
    const h = harness();
    h.directory.add('A', 'mecha', ['view', 'incidents:view'], true);
    const result = await h.ingest.ingest(
      h.event({
        kind: 'incident_sla',
        entityType: 'incident',
        entityId: 'inc-9',
        recipients: ['mecha'],
      }),
    );
    expect(result.skipped).toBe(1);
  });

  it('adds the followers of a followable entity', async () => {
    const h = harness();
    await h.store.subscribe({
      tenantId: 'A',
      recipientId: 'luis',
      entityType: 'incident',
      entityId: 'inc-1',
      createdAt: h.now().toISOString(),
    });
    const base = {
      kind: 'incident_status_changed' as const,
      entityType: 'incident' as const,
      entityId: 'inc-1',
      title: 'Siniestro En revisión · SIN-1',
      link: '/incidents/inc-1',
      dateVersion: 'v2',
      threshold: 'status',
    };
    const result = await h.ingest.ingest(h.event({ ...base, recipients: ['ana'] }));
    expect(result.created).toBe(2);
    // The same person as responsible and follower is one notice.
    const merged = await h.ingest.ingest(
      h.event({ ...base, dateVersion: 'v3', recipients: ['luis'] }),
    );
    expect(merged.created).toBe(1);
    // Followers do not get kinds that have none (a document).
    await h.ingest.ingest(h.event({ entityId: 'inc-1', recipients: [] }));
    expect((await list(h, 'A', 'luis')).total).toBe(2);
  });

  it('stops delivering to a follower who lost the right to see the entity', async () => {
    const h = harness();
    await h.store.subscribe({
      tenantId: 'A',
      recipientId: 'luis',
      entityType: 'vehicle',
      entityId: 'v1',
      createdAt: h.now().toISOString(),
    });
    h.directory.members.set('A|luis', { permissions: ['incidents:view'], mechanicLinked: false });
    const result = await h.ingest.ingest(
      h.event({ kind: 'vehicle_out_of_service', entityId: 'v1', recipients: [] }),
    );
    expect(result).toEqual({ created: 0, duplicates: 0, skipped: 1 });
  });
});

describe('channels', () => {
  it('creates the in-app notice at once and queues the e-mail', async () => {
    const h = harness();
    await h.ingest.ingest(h.event());
    const notice = (await list(h)).items[0]!;
    const deliveries = await h.store.deliveries('A', notice.id);
    expect(deliveries.map((d) => [d.channel, d.status])).toEqual([
      ['in_app', 'sent'],
      ['email', 'pending'],
    ]);
    expect(deliveries[1]?.nextAttemptAt).toBe(h.now().toISOString());
  });

  it('respects what the person switched off, but never the mandatory notices', async () => {
    const h = harness();
    const ana = h.actor('A', 'ana');
    const prefs = (await h.service.preferences(ana)).map((row) => ({
      eventKind: row.eventKind,
      inApp: row.mandatory,
      email: row.mandatory,
    }));
    await h.service.savePreferences(ana, prefs);
    const optional = await h.ingest.ingest(h.event());
    expect(optional).toEqual({ created: 0, duplicates: 0, skipped: 1 });
    for (const [kind, entity] of [
      ['work_order_assigned', 'ord-1'],
      ['export_ready', 'exp-1'],
      ['incident_sla', 'inc-1'],
    ] as const)
      await h.ingest.ingest(
        h.event({
          kind,
          entityId: entity,
          entityType: kind === 'incident_sla' ? 'incident' : 'export',
          title: `${kind} · X`,
        }),
      );
    expect((await list(h)).total).toBe(3);
    await h.dispatcher.runDue('A');
    // The SLA notice is e-mailed by INC-SLA, not by this module.
    expect(h.sink.messages.map((m) => m.template).sort()).toEqual([
      'export_ready',
      'work_order_assigned',
    ]);
  });

  it('keeps only the e-mail when the person turned the center off, and only the center when they turned the e-mail off', async () => {
    const h = harness();
    const ana = h.actor('A', 'ana');
    await h.service.savePreferences(ana, [
      { eventKind: 'document_expiring', inApp: false, email: true },
      { eventKind: 'maintenance_upcoming', inApp: true, email: false },
    ]);
    await h.ingest.ingest(h.event());
    await h.ingest.ingest(
      h.event({ kind: 'maintenance_upcoming', entityType: 'maintenance_plan', entityId: 'plan-1' }),
    );
    expect((await list(h)).items.map((n) => n.eventKind)).toEqual(['maintenance_upcoming']);
    await h.dispatcher.runDue('A');
    expect(h.sink.messages.map((m) => m.template)).toEqual(['document_expiring']);
  });

  it('follows the company rule: kinds it does not e-mail only reach the center', async () => {
    const h = harness();
    const admin = h.actor('A', 'root');
    await h.service.saveRule(admin, { emailKinds: ['export_ready'], quietHours: false });
    await h.ingest.ingest(h.event());
    await h.dispatcher.runDue('A');
    expect(h.sink.messages).toHaveLength(0);
    expect((await list(h)).total).toBe(1);
    expect(
      (await h.store.deliveries('A', (await list(h)).items[0]!.id)).map((d) => d.channel),
    ).toEqual(['in_app']);
  });
});

describe('quiet hours', () => {
  it('sends the in-app notice now and defers the e-mail to 07:00 local', async () => {
    const h = harness();
    await h.service.saveRule(h.actor('A', 'root'), {
      emailKinds: ['document_expiring'],
      quietHours: true,
    });
    // 23:00 in Mexico City is 05:00 UTC of the next day.
    h.setNow('2026-10-20T05:00:00.000Z');
    await h.ingest.ingest(h.event());
    const notice = (await list(h)).items[0]!;
    expect(notice.createdAt).toBe('2026-10-20T05:00:00.000Z');
    const [inApp, email] = await h.store.deliveries('A', notice.id);
    expect(inApp?.status).toBe('sent');
    expect(email?.nextAttemptAt).toBe('2026-10-20T13:00:00.000Z');
    await h.dispatcher.runDue('A');
    expect(h.sink.messages).toHaveLength(0);
    h.setNow('2026-10-20T13:00:00.000Z');
    expect(await h.dispatcher.runDue('A')).toMatchObject({ sent: 1 });
  });

  it('defers at dispatch when the quiet hours began after the notice was queued', async () => {
    const h = harness();
    h.setNow('2026-10-20T04:00:00.000Z');
    await h.ingest.ingest(h.event());
    await h.service.saveRule(h.actor('A', 'root'), {
      emailKinds: ['document_expiring'],
      quietHours: true,
    });
    expect(await h.dispatcher.runDue('A')).toMatchObject({ deferred: 1, sent: 0 });
    const notice = (await list(h)).items[0]!;
    expect((await h.store.deliveries('A', notice.id))[1]).toMatchObject({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: '2026-10-20T13:00:00.000Z',
    });
  });
});

describe('validation', () => {
  it.each([
    ['tenantId', { tenantId: 'bad id' }],
    ['kind', { kind: 'nope' }],
    ['entityId', { entityId: '' }],
    ['title', { title: '   ' }],
    ['title', { title: 'x'.repeat(161) }],
    ['link', { link: 'https://evil.test/x' }],
    ['link', { link: '//evil.test' }],
    ['severity', { severity: 'loud' }],
    ['dateVersion', { dateVersion: 'a b' }],
    ['threshold', { threshold: '' }],
    ['recipients', { recipients: ['ok', 'not ok'] }],
  ])('refuses an event with a bad %s', async (field, over) => {
    const h = harness();
    const failure = await h.ingest
      .ingest(h.event(over as never))
      .catch((error: unknown) => error as NotificationError);
    expect(failure).toBeInstanceOf(NotificationError);
    expect((failure as NotificationError).field).toBe(field);
  });
});
