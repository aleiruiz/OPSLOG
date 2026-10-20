import { inflateRawSync } from 'node:zlib';
import { describe, vi } from 'vitest';
import type { Browser } from '../../apps/api/bff/src/test-support.js';
import type { Platform, PlatformAdapters } from '../../apps/api/composition/src/index.js';
import type {
  AttemptResult,
  Resolver,
  WebhookRequest,
} from '../../packages/platform/webhooks/src/index.js';
import { SinkMailAdapter } from '../../packages/platform/mail/src/index.js';
import { adminUrl, startFleetDatabase, type FleetDatabase } from '../e2e/fleet/mysql.js';
import { startFleetWorld, type FleetWorld } from '../e2e/fleet/world.js';

/**
 * Arnés de la suite de aceptación independiente (MVP-QA-M5, etapa 1). Reutiliza los patrones del
 * arnés de flota: dos bases MySQL físicamente separadas (empresa A y B), cada una con su
 * composición y sus cuentas restringidas, y el BFF real por HTTP. Solo datos sintéticos.
 */
export { adminUrl };

/**
 * La suite de aceptación no se omite nunca: sin `OPSLOG_TEST_MYSQL_ADMIN_URL` falla en duro, porque
 * una aceptación que se salta en silencio no acepta nada (MVP-QA-M5, «sin skips no registrados»).
 */
if (!adminUrl)
  throw new Error(
    'test:acceptance requiere OPSLOG_TEST_MYSQL_ADMIN_URL (MySQL 8.4 de CI o un MySQL local sintético en loopback)',
  );
export const acceptance = describe;

/** Instante de partida de los escenarios (misma convención que el resto de las pruebas de flota). */
export const T0 = new Date('2026-11-01T16:00:00.000Z');

/** Receptor de webhooks sintético: registra cada petición firmada y responde con el estado fijado. */
export class Receiver {
  public readonly calls: WebhookRequest[] = [];
  public status = 200;
  public async send(request: WebhookRequest): Promise<AttemptResult> {
    this.calls.push(request);
    return this.status < 300
      ? { status: this.status, durationMs: 5, failure: null }
      : { status: this.status, durationMs: 5, failure: 'http' };
  }
}

/** DNS sintético: todo nombre resuelve a una dirección pública documental. */
export const publicResolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];

export interface AcceptanceWorld {
  readonly database: FleetDatabase;
  readonly fleet: FleetWorld;
  readonly mailA: SinkMailAdapter;
  readonly mailB: SinkMailAdapter;
  readonly receiverA: Receiver;
  readonly receiverB: Receiver;
  readonly adminA: Browser;
  readonly adminB: Browser;
  /** Segunda sesión de la administradora A (otro navegador) para carreras reales. */
  readonly adminA2: Browser;
  readonly editorA: Browser;
  readonly viewerA: Browser;
  readonly auditorA: Browser;
  close(): Promise<void>;
}

export interface AcceptanceOptions {
  /** Cliente de webhooks de A en lugar del receptor sintético (para probar la guardia SSRF real). */
  readonly webhookClientA?: PlatformAdapters['webhookClient'];
  readonly webhookResolverA?: Resolver;
}

export async function startAcceptance(options: AcceptanceOptions = {}): Promise<AcceptanceWorld> {
  const mailA = new SinkMailAdapter({ retain: 200 });
  const mailB = new SinkMailAdapter({ retain: 200 });
  const receiverA = new Receiver();
  const receiverB = new Receiver();
  const database = await startFleetDatabase();
  const fleet = await startFleetWorld(database, {
    a: {
      mail: mailA,
      webhookClient: options.webhookClientA ?? receiverA,
      webhookResolver: options.webhookResolverA ?? publicResolver,
    },
    b: { mail: mailB, webhookClient: receiverB, webhookResolver: publicResolver },
  });
  // La base sella `available_at` con su propio reloj; las fixtures usan T0.
  vi.setSystemTime(T0);
  // Las sesiones del arnés se abrieron en el reloj de partida del BFF: al mover el reloj caducan por
  // inactividad, así que todas se abren de nuevo ya en T0.
  await fleet.worldA.member('subject-admin-a', 'auditor', 'subject-auditor-a');
  const [adminA, adminA2, adminB, editorA, viewerA, auditorA] = await Promise.all([
    fleet.worldA.loginAs('subject-admin-a'),
    fleet.worldA.loginAs('subject-admin-a'),
    fleet.worldB.loginAs('subject-admin-b'),
    fleet.worldA.loginAs('subject-editor-a'),
    fleet.worldA.loginAs('subject-viewer-a'),
    fleet.worldA.loginAs('subject-auditor-a'),
  ]);
  return {
    database,
    fleet,
    mailA,
    mailB,
    receiverA,
    receiverB,
    adminA,
    adminB,
    adminA2,
    editorA,
    viewerA,
    auditorA,
    async close() {
      fleet.world.dispose();
      await database.close();
    },
  };
}

export async function drain(platform: Platform): Promise<void> {
  for (let round = 0; round < 20; round += 1)
    if ((await platform.runtime.drainOutbox(500)) === 0) return;
}

export function job(platform: Platform, name: string) {
  const found = platform.runtime.jobs.list().find((item) => item.name === name);
  if (!found) throw new Error(`job ${name} is not registered`);
  return found;
}

/** Vacía el outbox y corre los trabajos nombrados en orden (el worker de la demo corre en el proceso api). */
export async function tick(platform: Platform, ...names: string[]): Promise<void> {
  await drain(platform);
  for (const name of names) await job(platform, name).run();
  await drain(platform);
}

/** Reconstruye la proyección de búsqueda de la empresa (la cola durable está cubierta por persistencia). */
export async function reindex(platform: Platform, tenantId: string): Promise<void> {
  await platform.search.indexer.reconcile(tenantId);
}

export const ok = <T extends { status: number; text: string }>(
  reply: T,
  expected: number | number[] = [200, 201],
): T => {
  const list = Array.isArray(expected) ? expected : [expected];
  if (!list.includes(reply.status))
    throw new Error(
      `se esperaba ${list.join('/')} y llegó ${reply.status}: ${reply.text.slice(0, 300)}`,
    );
  return reply;
};

const DAY = 86_400_000;
/** Fecha de calendario (UTC) a `days` días del reloj de la prueba. */
export const dayFrom = (days: number): string =>
  new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

let counter = 0;
/** Cabecera `Idempotency-Key` que no se repite dentro de la corrida. */
export const key = (): { readonly 'idempotency-key': string } => {
  counter += 1;
  return { 'idempotency-key': `acc-key-${String(counter).padStart(8, '0')}-${Date.now()}` };
};

/** Etiqueta única por prueba para que las pruebas no dependan del orden ni choquen en unicidad. */
export const tag = (prefix: string): string => {
  counter += 1;
  return `${prefix}${String(counter).padStart(4, '0')}`;
};

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(512, 7),
]);
/** Cuerpo de evidencia de siniestro: una imagen sintética mínima ya comprimida. */
export const evidenceBody = (version: number, category: string, stage = 'other') => ({
  version,
  category,
  stage,
  name: `${category}.png`,
  contentType: 'image/png',
  clientCompressed: true,
  contentBase64: PNG.toString('base64'),
});

/** Copia los eventos de audit de la empresa al almacén consultable (el relé del worker, en un paso). */
export async function relayAudit(world: AcceptanceWorld, side: 'a' | 'b' = 'a'): Promise<void> {
  const tenant = side === 'a' ? world.database.tenantA : world.database.tenantB;
  for (let round = 0; round < 10; round += 1)
    if ((await tenant.runtime.adapters.auditRelay.runBatch(500)) === 0) return;
}

/** Lee un archivo del zip (XLSX) sin dependencias: directorio central + inflate. */
export function zipEntry(bytes: Uint8Array, name: string): string | null {
  const buf = Buffer.from(bytes);
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) return null;
  const entries = buf.readUInt16LE(end + 10);
  let offset = buf.readUInt32LE(end + 16);
  for (let i = 0; i < entries; i += 1) {
    const method = buf.readUInt16LE(offset + 10);
    const compressed = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extra = buf.readUInt16LE(offset + 30);
    const comment = buf.readUInt16LE(offset + 32);
    const local = buf.readUInt32LE(offset + 42);
    const entry = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (entry === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + compressed);
      return (method === 0 ? raw : inflateRawSync(raw)).toString('utf8');
    }
    offset += 46 + nameLength + extra + comment;
  }
  return null;
}
