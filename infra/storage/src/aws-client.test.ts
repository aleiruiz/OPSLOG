import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AwsS3ObjectClient } from './aws-client.js';

/** Tiny S3-compatible stub: path-style PUT (If-None-Match), GET, DELETE; records request headers. */
const objects = new Map<string, Buffer>();
const seen: { method: string; headers: Record<string, unknown> }[] = [];
let failing = false;
let server: Server;
let endpoint = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', headers: req.headers });
      const key = req.url?.split('?')[0] ?? '';
      if (failing) {
        res.writeHead(500).end();
      } else if (req.method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && objects.has(key)) {
          res
            .writeHead(412, { 'content-type': 'application/xml' })
            .end('<Error><Code>PreconditionFailed</Code></Error>');
        } else {
          // The SDK may frame the body with aws-chunked; keep it only when it is the plain payload.
          objects.set(key, Buffer.concat(chunks));
          res.writeHead(200, { etag: '"x"' }).end();
        }
      } else if (req.method === 'GET') {
        const body = objects.get(key);
        if (body) res.writeHead(200).end(body);
        else
          res
            .writeHead(404, { 'content-type': 'application/xml' })
            .end('<Error><Code>NoSuchKey</Code></Error>');
      } else if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const client = () =>
  new AwsS3ObjectClient({
    region: 'us-east-1',
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    endpoint,
  });
const put = (c: AwsS3ObjectClient, body = 'hello', kmsKeyId?: string) =>
  c.putObject({
    bucket: 'b',
    key: 'tenants/t/quarantine/originals/f',
    body: new TextEncoder().encode(body),
    contentType: 'text/plain',
    ifNoneMatch: '*',
    ...(kmsKeyId ? { kmsKeyId } : {}),
  });

describe('AwsS3ObjectClient against an S3-compatible stub', () => {
  it('creates once, reports exists on the conditional-write conflict, reads and deletes', async () => {
    const c = client();
    expect(await put(c)).toBe('created');
    expect(seen.at(-1)?.headers['if-none-match']).toBe('*');
    expect(seen.at(-1)?.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(await put(c, 'other')).toBe('exists');
    const got = await c.getObject({ bucket: 'b', key: 'tenants/t/quarantine/originals/f' });
    expect(new TextDecoder().decode(got ?? new Uint8Array())).toContain('hello');
    await c.deleteObject({ bucket: 'b', key: 'tenants/t/quarantine/originals/f' });
    expect(await c.getObject({ bucket: 'b', key: 'tenants/t/quarantine/originals/f' })).toBeNull();
  });
  it('sends SSE-KMS headers only when a key is given', async () => {
    const c = client();
    await put(c, 'plain');
    expect(seen.at(-1)?.headers['x-amz-server-side-encryption']).toBeUndefined();
    await c.deleteObject({ bucket: 'b', key: 'tenants/t/quarantine/originals/f' });
    await put(c, 'kms', 'alias/test');
    expect(seen.at(-1)?.headers['x-amz-server-side-encryption']).toBe('aws:kms');
    expect(seen.at(-1)?.headers['x-amz-server-side-encryption-aws-kms-key-id']).toBe('alias/test');
  });
  it('rethrows other failures so the adapter can map them', async () => {
    failing = true;
    await expect(
      client().getObject({ bucket: 'b', key: 'tenants/t/quarantine/originals/g' }),
    ).rejects.toThrow();
    failing = false;
  });
});
