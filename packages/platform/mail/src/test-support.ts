import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { createServer, type Server } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SmtpTestServer {
  readonly port: number;
  /** The certificate the server presents, to trust it. */
  readonly ca: string;
  readonly received: { from: string; to: string[]; data: string; user: string }[];
  close(): Promise<void>;
}

/**
 * A local SMTP server over implicit TLS with a throwaway certificate made by `openssl` for the
 * run (nothing is stored in the repository). It accepts any credentials and keeps what it receives.
 */
export async function startSmtpTestServer(): Promise<SmtpTestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'opslog-smtp-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    const cert = readFileSync(join(dir, 'c.pem'), 'utf8');
    const key = readFileSync(join(dir, 'k.pem'), 'utf8');
    const received: SmtpTestServer['received'] = [];
    const sockets = new Set<Socket>();
    const server: Server = createServer({ key, cert }, (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let buffer = '';
      let data: string | null = null;
      let user = '';
      let awaitingAuth = false;
      let current = { from: '', to: [] as string[] };
      const reply = (line: string) => socket.write(`${line}\r\n`);
      const line = (text: string) => {
        if (data !== null) {
          data += `${text}\r\n`;
          if (text === '.') {
            received.push({ ...current, data: data.slice(0, -5), user });
            data = null;
            current = { from: '', to: [] };
            reply('250 queued');
          }
          return;
        }
        const upper = text.toUpperCase();
        if (awaitingAuth) {
          awaitingAuth = false;
          user = Buffer.from(text, 'base64').toString('utf8').split('\0')[1] ?? '';
          reply('235 ok');
        } else if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          reply('250-localhost');
          reply('250-AUTH PLAIN');
          reply('250 8BITMIME');
        } else if (upper.startsWith('AUTH PLAIN ')) {
          user = Buffer.from(text.slice(11), 'base64').toString('utf8').split('\0')[1] ?? '';
          reply('235 ok');
        } else if (upper.startsWith('AUTH PLAIN')) {
          awaitingAuth = true;
          reply('334 ');
        } else if (upper.startsWith('MAIL FROM:')) {
          current.from = text.slice(10).replace(/[<>\s]|SIZE=.*|BODY=.*/gi, '');
          reply('250 ok');
        } else if (upper.startsWith('RCPT TO:')) {
          current.to.push(text.slice(8).replace(/[<>\s]/g, ''));
          reply('250 ok');
        } else if (upper === 'DATA') {
          data = '';
          reply('354 go');
        } else if (upper === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('250 ok');
      };
      reply('220 localhost ESMTP');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index = buffer.indexOf('\r\n');
        while (index >= 0) {
          line(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          index = buffer.indexOf('\r\n');
        }
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return {
      port,
      ca: cert,
      received,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        }),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
