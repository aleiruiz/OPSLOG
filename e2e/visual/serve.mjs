// Static file server for the built Storybook (packages/ui/storybook-static). Node built-ins only: no network.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../packages/ui/storybook-static', import.meta.url));
const port = Number(process.env.STORYBOOK_STATIC_PORT ?? 6007);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    const file = normalize(join(root, pathname === '/' ? 'index.html' : pathname));
    if (!file.startsWith(root + sep)) throw new Error('outside root');
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
    });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1');
