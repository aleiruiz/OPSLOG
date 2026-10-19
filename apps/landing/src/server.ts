import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { escapeHtml, isAdmin, renderLeadsPage } from './admin.js';
import type { LandingConfig } from './config.js';
import { parseLead, type Lead } from './lead.js';
import { leadsToCsv, type LeadStore } from './store.js';

const MAX_BODY = 16 * 1024;
const WINDOW_MS = 15 * 60 * 1000;
/** Per visitor address and window. */
const PER_CLIENT = 5;
/** All visitors together per window: bounds the disk a flood can fill. */
const GLOBAL = 200;

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
} as const;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

export interface LandingDeps {
  readonly config: LandingConfig;
  readonly store: LeadStore;
  readonly log?: (line: string) => void;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
}

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

const json = (res: ServerResponse, status: number, value: unknown): void =>
  send(res, status, JSON.stringify(value), {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });

/** Resolves `undefined` once the body passes MAX_BODY; the rest is drained so the 413 reaches the client. */
function readBody(req: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY * 64) req.destroy();
      else if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () =>
      resolve(size > MAX_BODY ? undefined : Buffer.concat(chunks).toString('utf8')),
    );
    req.on('error', reject);
    // A destroyed request emits neither `end` nor `error`.
    req.on('close', () => resolve(undefined));
  });
}

/** The proxy (Coolify's Traefik) appends the real client address last; earlier entries are client-supplied. */
function clientAddress(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const list = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '')).split(',');
  const last = list[list.length - 1]?.trim();
  return last || req.socket.remoteAddress || 'unknown';
}

function createRateLimiter(now: () => number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const since = now() - WINDOW_MS;
    const recent = (k: string) => (hits.get(k) ?? []).filter((at) => at > since);
    const client = recent(key);
    const all = recent('*');
    if (client.length >= PER_CLIENT || all.length >= GLOBAL) return false;
    hits.set(key, [...client, now()]);
    hits.set('*', [...all, now()]);
    if (hits.size > 10_000) for (const k of hits.keys()) if (!recent(k).length) hits.delete(k);
    return true;
  };
}

function notify(deps: LandingDeps, lead: Lead): void {
  const url = deps.config.notifyUrl;
  if (!url) return;
  // Visitor text must not become Slack links or mentions (`<!channel>`, `<https://x|y>`, `@everyone`).
  const plain = (value: string) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/@/g, '@\u200b');
  const text = `Nueva solicitud de demo de OPSLOG: ${plain(lead.nombre)} (${plain(lead.empresa)}), ${plain(lead.correo)}, ${lead.flotilla} vehículos.`;
  (deps.fetch ?? fetch)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // `text` for Slack-style hooks, `content` for Discord.
    body: JSON.stringify({ text, content: text, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(5000),
  }).then(
    (response) => {
      if (!response.ok) deps.log?.(`notify_failed status ${response.status}`);
    },
    () => deps.log?.('notify_failed network'),
  );
}

async function handleLead(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LandingDeps,
  allow: (key: string) => boolean,
): Promise<void> {
  const type = req.headers['content-type'] ?? '';
  const isJson = type.startsWith('application/json');
  const fail = (status: number, error: string, fields: readonly string[] = []) =>
    isJson
      ? json(res, status, { error, fields })
      : send(res, 303, '', { location: `/?error=${error}#contacto` });

  if (!isJson && !type.startsWith('application/x-www-form-urlencoded')) return fail(415, 'formato');
  const raw = await readBody(req);
  if (raw === undefined) return fail(413, 'tamano');
  let input: Record<string, unknown>;
  try {
    input = isJson
      ? (JSON.parse(raw) as Record<string, unknown>)
      : Object.fromEntries(new URLSearchParams(raw));
  } catch {
    return fail(400, 'formato');
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return fail(400, 'formato');

  const result = parseLead(input);
  if (result.kind === 'invalid') return fail(422, 'campos', result.fields);
  if (!allow(clientAddress(req))) {
    deps.log?.('rate_limited');
    return fail(429, 'limite');
  }
  if (result.kind === 'lead') {
    await deps.store.save(result.lead);
    deps.log?.('lead_saved');
    notify(deps, result.lead);
  }
  return isJson ? json(res, 201, { ok: true }) : send(res, 303, '', { location: '/gracias.html' });
}

async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LandingDeps,
  path: string,
): Promise<void> {
  const password = deps.config.adminPassword;
  if (!password) return send(res, 404, 'No encontrado', { 'content-type': 'text/plain' });
  if (!isAdmin(req.headers.authorization, password))
    return send(res, 401, 'Se requiere usuario y contraseña', {
      'www-authenticate': 'Basic realm="OPSLOG leads", charset="UTF-8"',
      'content-type': 'text/plain; charset=utf-8',
    });
  const leads = await deps.store.list();
  const privateHeaders = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };
  if (path === '/admin/leads.csv')
    return send(res, 200, leadsToCsv(leads), {
      ...privateHeaders,
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="solicitudes-opslog.csv"',
    });
  return send(res, 200, renderLeadsPage(leads), {
    ...privateHeaders,
    'content-type': 'text/html; charset=utf-8',
  });
}

async function serveStatic(res: ServerResponse, deps: LandingDeps, path: string): Promise<void> {
  let relative: string;
  try {
    relative = normalize(path === '/' ? '/index.html' : decodeURIComponent(path));
  } catch {
    return notFound(res, deps);
  }
  const root = deps.config.publicDir;
  const file = join(root, relative);
  const type = TYPES[extname(file)];
  if (!file.startsWith(root + sep) || !type) return notFound(res, deps);
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return notFound(res, deps);
  }
  const isHtml = type.startsWith('text/html');
  send(res, 200, isHtml ? withContact(body.toString('utf8'), deps) : body, {
    'content-type': type,
    'cache-control': isHtml ? 'no-cache' : 'public, max-age=86400',
  });
}

/** Fills the contact placeholder of the privacy notice. */
function withContact(html: string, deps: LandingDeps): string {
  const email = deps.config.contactEmail;
  const contact = email
    ? `<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>`
    : 'el formulario de contacto de esta página';
  return html.replaceAll('{{CONTACTO}}', contact);
}

async function notFound(res: ServerResponse, deps: LandingDeps): Promise<void> {
  try {
    const page = await readFile(join(deps.config.publicDir, '404.html'), 'utf8');
    send(res, 404, page, { 'content-type': 'text/html; charset=utf-8' });
  } catch {
    send(res, 404, 'No encontrado', { 'content-type': 'text/plain; charset=utf-8' });
  }
}

/** Request handler of the landing: static page, demo-request endpoint and the private lead list. */
export function createLandingHandler(deps: LandingDeps) {
  const allow = createRateLimiter(deps.now ?? Date.now);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const path = new URL(req.url ?? '/', 'http://landing').pathname;
      if (path === '/healthz') return json(res, 200, { status: 'ok' });
      if (path === '/api/leads')
        return req.method === 'POST'
          ? await handleLead(req, res, deps, allow)
          : send(res, 405, '', { allow: 'POST' });
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return send(res, 405, '', { allow: 'GET' });
      if (path === '/admin/leads' || path === '/admin/leads.csv')
        return await handleAdmin(req, res, deps, path);
      return await serveStatic(res, deps, path);
    } catch {
      deps.log?.('request_failed');
      if (!res.headersSent) json(res, 500, { error: 'interno' });
      else res.end();
    }
  };
}

export function startLanding(deps: LandingDeps): Promise<Server> {
  const handler = createLandingHandler(deps);
  const server = createServer((req, res) => void handler(req, res));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.config.port, deps.config.host, () => resolve(server));
  });
}
