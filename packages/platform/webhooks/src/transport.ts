import { request } from 'node:https';
import type { ClientRequest } from 'node:http';

export interface TransportRequest {
  /** The validated address to connect to. */
  readonly address: string;
  readonly family: 4 | 6;
  /** Host name for SNI, certificate check and the Host header. */
  readonly hostname: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly timeoutMs: number;
}
export interface TransportResponse {
  readonly status: number;
}
/** What actually touches the network. The safe client is the only caller. */
export type Transport = (input: TransportRequest) => Promise<TransportResponse>;

/** The response body is read up to this many bytes and thrown away. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

export type TransportFailure = 'timeout' | 'connection' | 'tls';
export class TransportError extends Error {
  public constructor(public readonly code: TransportFailure) {
    super(`webhook transport failed: ${code}`);
    this.name = 'TransportError';
  }
}

const TLS_CODES = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|HOSTNAME_MISMATCH|DEPTH_ZERO/i;

/** TLS to the pinned address with the host name as SNI; certificate verification stays on. */
export function httpsTransport(
  options: { readonly ca?: string | Buffer; readonly port?: number } = {},
): Transport {
  return (input) =>
    new Promise<TransportResponse>((resolve, reject) => {
      let settled = false;
      // Total deadline of the attempt (connect, TLS, headers and body): the idle timeout alone lets
      // a receiver that drips one byte at a time hold the attempt open for as long as it likes.
      let deadline: NodeJS.Timeout | undefined;
      const done = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        action();
      };
      const req: ClientRequest = request(
        {
          host: input.hostname,
          servername: input.hostname,
          port: options.port ?? 443,
          method: 'POST',
          path: input.path,
          headers: { ...input.headers, 'Content-Length': String(input.body.length) },
          // The only name resolution of the connection: the address already judged public.
          lookup: (_name, lookupOptions, callback) => {
            const answer = { address: input.address, family: input.family };
            // Node asks for every address when it tries both families (`all: true`).
            if ((lookupOptions as { all?: boolean }).all)
              (callback as (e: null, list: (typeof answer)[]) => void)(null, [answer]);
            else
              (callback as (e: null, a: string, f: number) => void)(
                null,
                answer.address,
                answer.family,
              );
          },
          timeout: input.timeoutMs,
          agent: false,
          ...(options.ca === undefined ? {} : { ca: options.ca }),
        },
        (response) => {
          let received = 0;
          response.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_RESPONSE_BYTES) {
              // Stop reading: what the receiver says is not kept anyway.
              response.destroy();
              done(() => resolve({ status: response.statusCode ?? 0 }));
            }
          });
          response.on('end', () => done(() => resolve({ status: response.statusCode ?? 0 })));
          response.on('error', () => done(() => resolve({ status: response.statusCode ?? 0 })));
          response.on('close', () => done(() => resolve({ status: response.statusCode ?? 0 })));
        },
      );
      deadline = setTimeout(() => {
        req.destroy();
        done(() => reject(new TransportError('timeout')));
      }, input.timeoutMs);
      req.on('timeout', () => {
        req.destroy();
        done(() => reject(new TransportError('timeout')));
      });
      req.on('error', (error: NodeJS.ErrnoException) =>
        done(() =>
          reject(new TransportError(TLS_CODES.test(error.code ?? '') ? 'tls' : 'connection')),
        ),
      );
      req.end(Buffer.from(input.body));
    });
}
