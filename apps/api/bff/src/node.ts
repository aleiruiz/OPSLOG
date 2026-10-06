import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { errorResponse, type BffHandler, type BffResponse } from './http.js';

/** Streams a request body without destroying the socket when the handler stops reading early. */
async function* bodyOf(request: IncomingMessage): AsyncGenerator<Uint8Array> {
  for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>)
    yield chunk;
}

function write(response: ServerResponse, result: BffResponse): void {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(result.headers))
    headers[name] = typeof value === 'string' ? value : [...value];
  headers['content-length'] = String(Buffer.byteLength(result.body));
  response.writeHead(result.status, headers);
  response.end(result.body);
}

/**
 * Adapts a `BffHandler` to Node's `http`. It adds no behaviour: limits, checks and error bodies all
 * live in the handler. Unread request bodies are drained and the connection is closed after the response.
 */
export function createNodeListener(
  handler: BffHandler,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void (async () => {
      let result: BffResponse;
      try {
        result = await handler({
          method: request.method as string,
          url: request.url as string,
          // Distinct values: Node's `headers` silently keeps the first of a repeated host or
          // content-type; the handler must see the repetition to treat it as ambiguous.
          headers: request.headersDistinct,
          body: bodyOf(request),
        });
      } catch {
        result = errorResponse('internal_error', 'unavailable');
      }
      // A body that was not read (early refusal) is drained and the connection closed after the
      // response: the client receives the verdict instead of a reset, and nothing is buffered.
      if (!request.complete) {
        request.resume();
        result = { ...result, headers: { ...result.headers, connection: 'close' } };
      }
      write(response, result);
    })();
  };
}

/**
 * HTTP server with conservative limits. The caller decides where to listen and, in deployment,
 * terminates TLS in front of it (cookies are always `Secure`).
 */
export function createBffServer(handler: BffHandler): Server {
  const server = createServer({ maxHeaderSize: 8192 }, createNodeListener(handler));
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}
