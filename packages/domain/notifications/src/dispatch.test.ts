import { describe, expect, it } from 'vitest';
import { MailError } from '../../../platform/mail/src/index.js';
import { FailingMail, harness } from './test-support.js';

const MINUTE = 60_000;

describe('e-mail delivery', () => {
  it('sends the template of the kind with the company name and a link, once', async () => {
    const h = harness({ baseUrl: 'https://opslog.example.test/' });
    await h.ingest.ingest(h.event());
    expect(await h.dispatcher.runDue('A')).toEqual({
      sent: 1,
      retried: 0,
      failed: 0,
      suppressed: 0,
      deferred: 0,
    });
    const [message] = h.sink.messages;
    expect(message).toMatchObject({
      companyId: 'A',
      to: 'ana@example.test',
      template: 'document_expiring',
      subject: 'OPSLOG · Empresa Alfa: Seguro vence en 7 días · ECO-1',
    });
    expect(message?.text).toContain('https://opslog.example.test/flota/vehiculos/v1');
    expect(message?.idempotencyKey).toBe('n-1:email');
    // Nothing is left to send.
    expect(await h.dispatcher.runDue('A')).toMatchObject({ sent: 0 });
    expect(h.sink.messages).toHaveLength(1);
    const notice = (await h.service.list(h.actor('A', 'ana'))).items[0]!;
    expect((await h.store.deliveries('A', notice.id))[1]).toMatchObject({
      status: 'sent',
      attempts: 1,
      lastError: null,
    });
  });

  it('keeps the in-app notice and retries at 1m, 5m and 30m before it fails for good', async () => {
    const mail = new FailingMail();
    const h = harness({ mail });
    await h.ingest.ingest(h.event());
    const notice = (await h.service.list(h.actor('A', 'ana'))).items[0]!;
    const email = async () => (await h.store.deliveries('A', notice.id))[1]!;

    expect(await h.dispatcher.runDue('A')).toMatchObject({ retried: 1 });
    expect(await email()).toMatchObject({ status: 'pending', attempts: 1, lastError: 'unknown' });
    expect(Date.parse((await email()).nextAttemptAt!) - h.now().getTime()).toBe(1 * MINUTE);
    // Not due yet: nothing is tried.
    expect(await h.dispatcher.runDue('A')).toMatchObject({ retried: 0, failed: 0 });
    expect(mail.calls).toBe(1);

    h.advance(1 * MINUTE);
    await h.dispatcher.runDue('A');
    expect(Date.parse((await email()).nextAttemptAt!) - h.now().getTime()).toBe(5 * MINUTE);
    h.advance(5 * MINUTE);
    await h.dispatcher.runDue('A');
    expect(Date.parse((await email()).nextAttemptAt!) - h.now().getTime()).toBe(30 * MINUTE);
    h.advance(30 * MINUTE);
    expect(await h.dispatcher.runDue('A')).toMatchObject({ failed: 1 });
    expect(await email()).toMatchObject({ status: 'failed', attempts: 4, lastError: 'unknown' });
    expect(mail.calls).toBe(4);
    h.advance(24 * 60 * MINUTE);
    await h.dispatcher.runDue('A');
    expect(mail.calls).toBe(4);

    // The center still has it, and the administrator can see the failure without any address.
    expect((await h.service.list(h.actor('A', 'ana'))).total).toBe(1);
    const failed = await h.service.failedDeliveries(h.actor('A', 'root'));
    expect(failed.total).toBe(1);
    expect(failed.items[0]).toMatchObject({
      eventKind: 'document_expiring',
      channel: 'email',
      attempts: 4,
    });
    expect(JSON.stringify(failed)).not.toContain('@');
  });

  it('keeps only the code of a provider failure', async () => {
    const h = harness({ mail: new FailingMail(new MailError('timeout')) });
    await h.ingest.ingest(h.event());
    await h.dispatcher.runDue('A');
    const notice = (await h.service.list(h.actor('A', 'ana'))).items[0]!;
    const row = (await h.store.deliveries('A', notice.id))[1]!;
    expect(row.lastError).toBe('timeout');
    expect(JSON.stringify(row)).not.toContain('example.test');
  });

  it('suppresses the send to a member who lost the right, left the company or has no address', async () => {
    const h = harness();
    await h.ingest.ingest(h.event({ recipients: ['ana', 'luis', 'root'] }));
    h.directory.members.set('A|ana', { permissions: ['incidents:view'], mechanicLinked: false });
    h.directory.members.delete('A|luis');
    h.directory.addresses.delete('A|root');
    expect(await h.dispatcher.runDue('A')).toMatchObject({ sent: 0, suppressed: 3 });
    expect(h.sink.messages).toHaveLength(0);
    // The suppression is final: a later fix does not resurrect the send.
    h.directory.members.set('A|ana', { permissions: ['view'], mechanicLinked: false });
    expect(await h.dispatcher.runDue('A')).toMatchObject({ sent: 0, suppressed: 0 });
  });

  it('suppresses the send for an entity the member can no longer see, and for a kind the company stopped e-mailing', async () => {
    const h = harness();
    await h.ingest.ingest(h.event());
    await h.ingest.ingest(h.event({ entityId: 'doc-2', dateVersion: 'x' }));
    h.visibility.hidden.add('A|vehicle|doc-1');
    expect(await h.dispatcher.runDue('A')).toMatchObject({ sent: 1, suppressed: 1 });
    await h.ingest.ingest(h.event({ entityId: 'doc-3', dateVersion: 'y' }));
    await h.service.saveRule(h.actor('A', 'root'), { emailKinds: [], quietHours: false });
    expect(await h.dispatcher.runDue('A')).toMatchObject({ sent: 0, suppressed: 1 });
  });

  it('does not send for the same notice twice when two workers race', async () => {
    const h = harness();
    await h.ingest.ingest(h.event());
    const [a, b] = await Promise.all([h.dispatcher.runDue('A'), h.dispatcher.runDue('A')]);
    expect(a.sent + b.sent).toBe(1);
    expect(h.sink.messages).toHaveLength(1);
  });

  it('does not count or settle a send whose lease another worker took meanwhile', async () => {
    let rival: (() => Promise<unknown>) | undefined;
    const slow = {
      sends: 0,
      async send() {
        this.sends += 1;
        // The provider is so slow that the 2-minute lease runs out and a second worker takes over.
        if (this.sends === 1) {
          h.advance(3 * MINUTE);
          await rival?.();
        }
      },
    };
    const h = harness({ mail: slow });
    rival = () => h.dispatcher.runDue('A');
    await h.ingest.ingest(h.event());
    const notice = (await h.service.list(h.actor('A', 'ana'))).items[0]!;
    expect(await h.dispatcher.runDue('A')).toMatchObject({ sent: 0 });
    expect((await h.store.deliveries('A', notice.id))[1]).toMatchObject({
      status: 'sent',
      attempts: 1,
    });
  });

  it('skips a delivery it can no longer renew', async () => {
    const h = harness();
    await h.ingest.ingest(h.event());
    const store = h.store as unknown as { renew: () => Promise<string | null> };
    store.renew = async () => null;
    expect(await h.dispatcher.runDue('A')).toMatchObject({ sent: 0 });
    expect(h.sink.messages).toHaveLength(0);
  });

  it('never touches another company', async () => {
    const h = harness();
    await h.ingest.ingest(h.event({ tenantId: 'B' }));
    expect(await h.dispatcher.runDue('A')).toMatchObject({ sent: 0 });
    expect(await h.dispatcher.runDue('B')).toMatchObject({ sent: 1 });
    expect(h.sink.messages.map((m) => m.companyId)).toEqual(['B']);
  });
});
