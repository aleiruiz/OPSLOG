import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const TEST_HOST = 'hooks.example.com';

/** A throwaway self-signed certificate for the test host, generated per run (never stored). */
export function selfSigned(): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), 'opslog-wh-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
        '-days',
        '1',
        '-subj',
        `/CN=${TEST_HOST}`,
        '-addext',
        `subjectAltName=DNS:${TEST_HOST}`,
      ],
      { stdio: 'ignore' },
    );
    return {
      key: readFileSync(join(dir, 'k.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'c.pem'), 'utf8'),
    };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface Receiver {
  readonly port: number;
  readonly requests: { headers: IncomingMessage['headers']; body: Buffer; url: string }[];
  close(): Promise<void>;
}

export async function startReceiver(
  credentials: { key: string; cert: string },
  respond: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Receiver> {
  const requests: Receiver['requests'] = [];
  const server: Server = createServer(credentials, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks), url: req.url ?? '' });
      respond(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
