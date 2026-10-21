import AxeBuilder from '@axe-core/playwright';
import { expect as baseExpect, test, type Page } from '@playwright/test';
import { startRealStack, type RealTenant } from './real-api/harness.js';

const expect = baseExpect.configure({ timeout: 15_000 });

// MVP-QA-M5 etapa 2 (FIX-QA-23): axe WCAG 2.1 AA sobre las pantallas de M5 ya integradas y sobre
// algunas representativas de M1 a M4, con la shell web real contra el BFF compuesto y una base MySQL
// sintética desechable (sin mocks). Con datos: un vehículo, un conductor y un aviso de fuera de
// servicio, para que las pantallas no se evalúen solo en su estado vacío.
const adminUrl = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

test.describe.configure({ mode: 'serial', timeout: 240_000 });
test.use({ actionTimeout: 15_000 });
test.skip(!adminUrl && !process.env.CI, 'needs OPSLOG_TEST_MYSQL_ADMIN_URL (synthetic MySQL 8.4)');

let stack: Awaited<ReturnType<typeof startRealStack>>;
let a: RealTenant;
let vehicleId: string;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  if (!adminUrl)
    throw new Error('OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; the scan must not skip');
  stack = await startRealStack();
  ({ a } = stack);
  vehicleId = await a.vehicle('AX01');
  await a.driver('AX01');
  await a.outOfService(vehicleId, 'Revisión de accesibilidad');
  await a.tick();
  await a.tick();
});
test.afterAll(async () => {
  await stack?.close();
});

async function signIn(page: Page) {
  await page.goto(`${a.webUrl}/real/`);
  await expect(page.getByRole('heading', { name: 'Iniciar sesión', level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: /Cuenta de prueba/ }).fill('e2e-admin-a');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Iniciar sesión', level: 1 })).toHaveCount(0);
}

interface Screen {
  readonly name: string;
  readonly path: string;
}

const M5: readonly Screen[] = [
  { name: 'Inicio (dashboard)', path: '/' },
  { name: 'Búsqueda', path: '/buscar' },
  { name: 'Notificaciones', path: '/notificaciones' },
  { name: 'Preferencias de notificaciones', path: '/notificaciones/preferencias' },
  { name: 'Reportes (catálogo)', path: '/analisis/reportes' },
  { name: 'Reporte con datos', path: '/analisis/reportes?reporte=vehicle_inventory' },
  { name: 'Auditoría', path: '/analisis/auditoria' },
  { name: 'Integraciones (webhooks)', path: '/configuracion/integraciones' },
];

const EARLIER: readonly Screen[] = [
  { name: 'M1 · Vehículos', path: '/flota/vehiculos' },
  { name: 'M2 · Documentos', path: '/flota/documentos' },
  { name: 'M3 · Mantenimiento', path: '/flota/mantenimiento' },
  { name: 'M4 · Siniestros', path: '/incidents' },
  { name: 'Configuración · Usuarios', path: '/configuracion/usuarios' },
];

async function scan(page: Page, screen: Screen) {
  await page.goto(`${a.webUrl}/real${screen.path}`);
  // El encabezado de nivel 1 visible prueba que la pantalla cargó antes de analizarla.
  const title = page.locator('h1').first();
  await expect(title).toBeVisible();
  // Si la sesión no se mantuvo, la pantalla analizada sería el inicio de sesión y el análisis no valdría.
  await expect(title).not.toHaveText('Iniciar sesión');
  await expect(page).not.toHaveURL(/iniciar-sesion/);
  await page.waitForLoadState('networkidle');
  const results = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  // Que axe sí midió algo: reglas aplicadas en la página, no un análisis vacío.
  expect(results.passes.length).toBeGreaterThan(5);
  test.info().annotations.push({ type: 'h1', description: (await title.textContent()) ?? '' });
  expect(
    results.violations.map(
      (item) => `${item.id} (${item.impact}): ${item.nodes.map((n) => n.target).join(' | ')}`,
    ),
    screen.name,
  ).toEqual([]);
}

test.describe('axe WCAG 2.1 AA · pantallas de M5', () => {
  for (const screen of M5)
    test(screen.name, async ({ page }) => {
      await signIn(page);
      await scan(page, screen);
    });
});

test.describe('axe WCAG 2.1 AA · representativas de M1 a M4', () => {
  for (const screen of EARLIER)
    test(screen.name, async ({ page }) => {
      await signIn(page);
      await scan(page, screen);
    });
});
