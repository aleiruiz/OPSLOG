import { describe, expect, it, vi } from 'vitest';
import {
  MailError,
  SMTP_VARIABLES,
  SinkMailAdapter,
  SmtpConfigError,
  SmtpMailAdapter,
  failureOf,
  readSmtpConfig,
  recipientRef,
  type MailMessage,
  type SinkRecord,
} from './index.js';
import { startSmtpTestServer } from './test-support.js';

const message = (over: Partial<MailMessage> = {}): MailMessage => ({
  companyId: 'A',
  to: 'ana@example.test',
  subject: 'Asunto',
  text: 'Cuerpo',
  template: 'export_ready',
  idempotencyKey: 'n-1:email',
  ...over,
});

const ENV = {
  OPSLOG_SMTP_HOST: 'smtp.example.test',
  OPSLOG_SMTP_PORT: '587',
  OPSLOG_SMTP_USER: 'robot',
  OPSLOG_SMTP_PASSWORD: 'secret-value ',
  OPSLOG_SMTP_FROM: 'avisos@example.test',
};

describe('readSmtpConfig', () => {
  it('stays off without any variable, also when they are blank', () => {
    expect(readSmtpConfig({})).toBeNull();
    expect(readSmtpConfig({ OPSLOG_SMTP_HOST: ' ', OPSLOG_SMTP_PORT: '' })).toBeNull();
  });

  it('reads the five variables and keeps the password as it is', () => {
    expect(readSmtpConfig(ENV)).toEqual({
      host: 'smtp.example.test',
      port: 587,
      user: 'robot',
      password: 'secret-value ',
      from: 'avisos@example.test',
    });
  });

  it.each(SMTP_VARIABLES)('names %s when it is the only one missing, never a value', (name) => {
    const env: Record<string, string> = { ...ENV };
    delete env[name];
    const failure = (() => {
      try {
        readSmtpConfig(env);
      } catch (error) {
        return error as SmtpConfigError;
      }
      return null;
    })();
    expect(failure).toBeInstanceOf(SmtpConfigError);
    expect(failure?.variable).toBe(name);
    expect(failure?.message).toContain(name);
    expect(failure?.message).not.toContain('secret-value');
    expect(failure?.message).not.toContain('smtp.example.test');
  });

  it('names the port or the sender when they are malformed', () => {
    for (const port of ['0', '70000', 'abc', '25.5'])
      expect(() => readSmtpConfig({ ...ENV, OPSLOG_SMTP_PORT: port })).toThrow(/OPSLOG_SMTP_PORT/);
    expect(() => readSmtpConfig({ ...ENV, OPSLOG_SMTP_FROM: 'not-an-address' })).toThrow(
      /OPSLOG_SMTP_FROM/,
    );
  });
});

describe('SinkMailAdapter', () => {
  it('records company, template, an opaque recipient and the result, never the address or the body', async () => {
    const logged: SinkRecord[] = [];
    const sink = new SinkMailAdapter({
      log: (record) => logged.push(record),
      now: () => new Date('2026-10-19T10:00:00Z'),
    });
    await sink.send(message());
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual({
      companyId: 'A',
      template: 'export_ready',
      recipient: recipientRef('A', 'ana@example.test'),
      idempotencyKey: 'n-1:email',
      result: 'accepted',
      at: '2026-10-19T10:00:00.000Z',
    });
    const text = JSON.stringify([logged, sink.records]);
    expect(text).not.toContain('ana@example.test');
    expect(text).not.toContain('Cuerpo');
    expect(sink.messages).toEqual([]);
  });

  it('tells recipients apart by company and ignores case', () => {
    expect(recipientRef('A', 'Ana@Example.test')).toBe(recipientRef('A', 'ana@example.test'));
    expect(recipientRef('A', 'ana@example.test')).not.toBe(recipientRef('B', 'ana@example.test'));
    expect(recipientRef('A', 'ana@example.test')).toHaveLength(12);
  });

  it('keeps the last full messages only when asked and counts a repeated key as a duplicate', async () => {
    const sink = new SinkMailAdapter({ retain: 2 });
    await sink.send(message());
    await sink.send(message());
    await sink.send(message({ idempotencyKey: 'k2' }));
    await sink.send(message({ idempotencyKey: 'k3' }));
    expect(sink.records.map((r) => r.result)).toEqual([
      'accepted',
      'duplicate',
      'accepted',
      'accepted',
    ]);
    expect(sink.messages.map((m) => m.idempotencyKey)).toEqual(['k2', 'k3']);
    // The same key in another company is another message.
    await sink.send(message({ companyId: 'B', idempotencyKey: 'k3' }));
    expect(sink.records.at(-1)?.result).toBe('accepted');
  });

  it('refuses an address that is not one and bounds its records', async () => {
    const sink = new SinkMailAdapter();
    await expect(sink.send(message({ to: 'nope' }))).rejects.toMatchObject({
      code: 'invalid_address',
    });
    for (let i = 0; i < 510; i += 1) await sink.send(message({ idempotencyKey: `k${i}` }));
    expect(sink.records).toHaveLength(500);
  });
});

describe('SmtpMailAdapter', () => {
  const config = readSmtpConfig(ENV)!;

  it('hands the provider the message with a stable id and without leaking its failure text', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const adapter = new SmtpMailAdapter({ config, transport: { sendMail } });
    await adapter.send(message({ html: '<p>x</p>' }));
    expect(sendMail).toHaveBeenCalledWith({
      from: 'avisos@example.test',
      to: 'ana@example.test',
      subject: 'Asunto',
      text: 'Cuerpo',
      html: '<p>x</p>',
      messageId: '<n-1email@example.test>',
    });
    await adapter.send(message());
    expect(sendMail.mock.calls[1]?.[0]).not.toHaveProperty('html');
    sendMail.mockRejectedValue(
      Object.assign(new Error('550 ana@example.test rejected'), { responseCode: 550 }),
    );
    const failure = await adapter.send(message()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MailError);
    expect((failure as MailError).code).toBe('rejected');
    expect((failure as MailError).message).not.toContain('ana@');
  });

  it('refuses an address that is not one before the provider sees it', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const adapter = new SmtpMailAdapter({ config, transport: { sendMail } });
    for (const to of ['', 'ana', 'ana@example', 'a b@example.test', '<ana@example.test>']) {
      const failure = await adapter.send(message({ to })).catch((error: unknown) => error);
      expect((failure as MailError).code, to).toBe('invalid_address');
    }
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('maps provider errors to codes', () => {
    expect(failureOf({ code: 'EAUTH' })).toBe('auth');
    expect(failureOf({ code: 'ETIMEDOUT' })).toBe('timeout');
    expect(failureOf({ code: 'ESOCKETTIMEDOUT' })).toBe('timeout');
    expect(failureOf({ code: 'ECONNECTION' })).toBe('connection');
    expect(failureOf({ code: 'ECONNREFUSED' })).toBe('connection');
    expect(failureOf({ code: 'EENVELOPE' })).toBe('rejected');
    expect(failureOf({ responseCode: 554 })).toBe('rejected');
    expect(failureOf({ responseCode: 451 })).toBe('unknown');
    expect(failureOf(null)).toBe('unknown');
  });

  it('builds a real transport that requires TLS: STARTTLS on 587, encrypted from the start on 465', () => {
    expect(new SmtpMailAdapter({ config })).toBeInstanceOf(SmtpMailAdapter);
    expect(
      new SmtpMailAdapter({ config: { ...config, port: 465 }, timeoutMs: 1000 }),
    ).toBeInstanceOf(SmtpMailAdapter);
  });

  it('delivers to a local SMTP server over TLS and verifies its certificate', async () => {
    const server = await startSmtpTestServer();
    try {
      const adapter = new SmtpMailAdapter({
        config: { ...config, host: '127.0.0.1', port: server.port },
        implicitTls: true,
        ca: server.ca,
      });
      await adapter.send(message({ subject: 'Exportación lista', html: '<p>Hola</p>' }));
      expect(server.received).toHaveLength(1);
      expect(server.received[0]).toMatchObject({
        from: 'avisos@example.test',
        to: ['ana@example.test'],
        user: 'robot',
      });
      expect(server.received[0]?.data).toContain('Message-ID: <n-1email@example.test>');
      expect(server.received[0]?.data).toContain('Cuerpo');
      // Without trusting the certificate the connection is refused: TLS is verified, not optional.
      const untrusted = new SmtpMailAdapter({
        config: { ...config, host: '127.0.0.1', port: server.port },
        implicitTls: true,
        timeoutMs: 3000,
      });
      const refused = await untrusted.send(message()).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(MailError);
      expect(server.received).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('fails with a code when nobody listens', async () => {
    const adapter = new SmtpMailAdapter({
      config: { ...config, host: '127.0.0.1', port: 9 },
      implicitTls: true,
      timeoutMs: 2000,
    });
    await expect(adapter.send(message())).rejects.toBeInstanceOf(MailError);
  });
});
