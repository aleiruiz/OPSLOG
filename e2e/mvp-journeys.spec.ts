import { expect as baseExpect, test, type Page } from '@playwright/test';
import { ROLE_LABELS, ROLE_PERMISSIONS, type RoleName } from '../apps/api/composition/src/index.js';
import { startRealStack, type RealTenant } from './real-api/harness.js';

const expect = baseExpect.configure({ timeout: 15_000 });

// MVP-INTEGRATE PR 2: the M5 journey in the browser. The real web shell against the composed BFF over a
// disposable synthetic MySQL database, no mocks: a supervisor goes through dashboard, search, report and
// notification; a dispatcher without costs or personal data goes through the same and sees no amounts and
// no personal data. The two roles are synthetic templates that exist only while this file runs.
const adminUrl = process.env.OPSLOG_TEST_MYSQL_ADMIN_URL;
const SUPERVISOR = 'supervisor_m5';
const DISPATCHER = 'dispatcher_m5';
const templates = ROLE_PERMISSIONS as Record<string, readonly string[]>;
const labels = ROLE_LABELS as Record<string, string>;

test.describe.configure({ mode: 'serial', timeout: 240_000 });
test.use({ actionTimeout: 15_000 });
test.skip(!adminUrl && !process.env.CI, 'needs OPSLOG_TEST_MYSQL_ADMIN_URL (synthetic MySQL 8.4)');

let stack: Awaited<ReturnType<typeof startRealStack>>;
let a: RealTenant;
let b: RealTenant;
let vehicleId: string;
let vehicleB: string;
let license: string;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  if (!adminUrl)
    throw new Error('OPSLOG_TEST_MYSQL_ADMIN_URL is required in CI; the journey must not skip');
  templates[SUPERVISOR] = [
    'view',
    'create',
    'edit',
    'export',
    'view_pii',
    'view_costs',
    'incidents:view',
    'incidents:view_costs',
  ];
  templates[DISPATCHER] = ['view', 'export', 'incidents:view'];
  // The shell shows the label of the role in the avatar: a template needs one.
  labels[SUPERVISOR] = 'Supervisor sintético';
  labels[DISPATCHER] = 'Despachador sintético';
  stack = await startRealStack();
  ({ a, b } = stack);
  vehicleId = await a.vehicle('J01');
  ({ license } = await a.driver('J01'));
  await a.member(SUPERVISOR as RoleName, 'e2e-supervisor-a');
  await a.member(DISPATCHER as RoleName, 'e2e-dispatcher-a');
  // Company B has a vehicle with the same shape: it must never show up in A's journey.
  vehicleB = await b.vehicle('J01');
  await a.tick();
  await b.tick();
});
test.afterAll(async () => {
  delete templates[SUPERVISOR];
  delete templates[DISPATCHER];
  delete labels[SUPERVISOR];
  delete labels[DISPATCHER];
  await stack?.close();
});

async function signIn(page: Page, tenant: RealTenant, account: string, path = '/') {
  await page.goto(`${tenant.webUrl}/real${path}`);
  await expect(page.getByRole('heading', { name: 'Iniciar sesión', level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: /Cuenta de prueba/ }).fill(account);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Iniciar sesión', level: 1 })).toHaveCount(0);
}

/** Types in the search box and opens the hit of the vehicle. */
async function searchPlate(page: Page, plate: string) {
  const box = page.getByRole('combobox', { name: 'Buscar' });
  await box.fill(plate);
  return page.getByRole('option').filter({ hasText: plate });
}

test('supervisor: dashboard with costs, search, report with personal data and the notice', async ({
  page,
}) => {
  await signIn(page, a, 'e2e-supervisor-a');
  // Dashboard of Inicio: the counts and the cost indicator.
  await expect(page.getByText('Vehículos activos').first()).toBeVisible();
  await expect(page.getByText('Costo de mantenimiento').first()).toBeVisible();

  // Search finds the plate of company A and opens the detail.
  const hit = await searchPlate(page, 'MNJ01');
  await expect(hit.first()).toBeVisible();
  await hit.first().click();
  await expect(page).toHaveURL(new RegExp(`/flota/vehiculos/${vehicleId}`));

  // Follows the vehicle; then the vehicle goes out of service and the tick delivers the notice.
  await page.getByRole('button', { name: 'Seguir' }).click();
  await expect(page.getByRole('button', { name: /Siguiendo/ })).toBeVisible();
  await a.outOfService(vehicleId, 'Falla del recorrido');
  await a.tick();
  await a.tick();

  // Report: the preview shows the license to who may see personal data.
  await page.goto(`${a.webUrl}/real/analisis/reportes?reporte=drivers`);
  await expect(page.getByRole('cell', { name: license })).toBeVisible();

  // Notification: the bell has a counter and the list names the event, not the free text.
  await page.goto(`${a.webUrl}/real/notificaciones`);
  await expect(
    page.getByRole('link', { name: /Vehículo fuera de servicio · MNT-J01/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /Notificaciones, \d+ sin leer/ })).toBeVisible();
  await expect(page.getByText('Falla del recorrido')).toHaveCount(0);
});

test('dispatcher without costs or personal data: same journey, no amounts and no personal data', async ({
  page,
}) => {
  await signIn(page, a, 'e2e-dispatcher-a');
  await expect(page.getByText('Vehículos activos').first()).toBeVisible();
  await expect(page.getByText('Costo de mantenimiento')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(/\$\s?\d/);

  const hit = await searchPlate(page, 'MNJ01');
  await expect(hit.first()).toBeVisible();
  // The license of the driver is personal data: not searchable by who cannot read it.
  await page.getByRole('combobox', { name: 'Buscar' }).fill(license);
  await expect(
    page.getByRole('paragraph').filter({ hasText: 'No encontramos resultados.' }),
  ).toBeVisible();

  await page.goto(`${a.webUrl}/real/analisis/reportes?reporte=drivers`);
  await expect(page.getByRole('cell', { name: 'Perez' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: license })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(license);

  // The catalog does not offer the cost reports.
  await page.goto(`${a.webUrl}/real/analisis/reportes`);
  await expect(page.getByRole('heading', { name: 'Reportes', level: 1 })).toBeVisible();
  // The list has loaded (a report the role may see is there) before the cost reports are checked.
  await expect(page.getByLabel(/Abrir reporte: Conductores/)).toBeVisible();
  await expect(page.getByText('Costos de mantenimiento')).toHaveCount(0);

  await page.goto(`${a.webUrl}/real/notificaciones`);
  await expect(page.getByRole('heading', { name: 'Notificaciones', level: 1 })).toBeVisible();
  await expect(page.locator('main')).not.toContainText(/\$\s?\d|99999|amountMinor/);
});

test('company B signs in to its own space and sees nothing of company A', async ({ page }) => {
  await signIn(page, b, 'e2e-admin-b');
  const hit = await searchPlate(page, 'MNJ01');
  // Company B has its own MNJ01 (same tag): the hit opens B's vehicle, never A's.
  await expect(hit.first()).toBeVisible();
  await hit.first().click();
  await expect(page).toHaveURL(new RegExp(`/flota/vehiculos/${vehicleB}`));
  expect(vehicleB).not.toBe(vehicleId);
  await page.goto(`${b.webUrl}/real/flota/vehiculos/${vehicleId}`);
  await expect(page.getByRole('heading', { name: 'Vehículo no encontrado' })).toBeVisible();
  await expect(page.getByText(license)).toHaveCount(0);
  await expect(page.getByText('MNJ01')).toHaveCount(0);
});
